import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as metricsModule from './metrics.mjs';
const {validatePrivateMetrics, mergePrivateMetrics} = metricsModule;

const version = '0123456789abcdef';
const keyFor = id => createHash('sha256').update(`poly-tally/repository/${id}`).digest('hex').slice(0, 16);
const metrics = code => ({code, comment: 2, blank: 3, documentation: 4, files: 1});
function privateRepository(id = '101', overrides = {}) {
  const sourceKey = keyFor(id);
  return {id: `private-${sourceKey}`, sourceKey, name: `私有仓库 · ${sourceKey.slice(0, 6)}`, visibility: 'private', snapshotKind: 'daily', url: null, branch: null, head: null, status: 'active', lastSuccessAt: '2026-10-21T03:00:00Z', rulesVersion: version, historyComplete: true, notice: '私有仓库：仅公开按日规模，不公开源码与提交详情。', skippedFiles: 0, history: [{timestamp: '2026-10-20T23:59:59.999999Z', metrics: metrics(10), languages: {Python: metrics(10)}}], ...overrides};
}
function envelope(repositories = [privateRepository()]) {
  return {schemaVersion: 1, generatedAt: '2026-10-21T04:00:00Z', rulesVersion: version, source: 'local', collection: {repositories: repositories.length, failed: 0}, repositories};
}
function publicRepository(id = '202', overrides = {}) {
  return {id, name: 'owner/public', status: 'active', rulesVersion: version, history: [{timestamp: '2026-10-19T13:01:00Z', sha: 'public-sha', metrics: metrics(20), languages: {Python: metrics(20)}}], ...overrides};
}
const publicStats = repositories => ({schemaVersion: 1, generatedAt: '2026-10-21T05:00:00Z', rules: {version}, summary: {code: 999}, repositories});

test('accepts the sanitized daily envelope including an empty inventory', () => {
  assert.equal(validatePrivateMetrics(envelope()), true);
  assert.equal(validatePrivateMetrics(envelope([])), true);
});

test('publishes authorized real names while retaining stable identities and legacy aliases', () => {
  const previous = envelope();
  const next = envelope([privateRepository('101', {name: 'example-owner/private-project'})]);
  assert.equal(validatePrivateMetrics(next), true);
  assert.equal(metricsModule.validatePrivateMetricsReplacement(previous, next), true);
  const result = mergePrivateMetrics(publicStats([]), next);
  assert.equal(result.repositories[0].name, 'example-owner/private-project');
  assert.equal(result.repositories[0].id, previous.repositories[0].id);
  assert.deepEqual(result.repositories[0].history, previous.repositories[0].history);
  for (const name of ['../private', 'owner/repo/sha', '<script>secret</script>', 'owner/repo\nmessage', 'owner/..', '私有仓库 · badbad']) {
    assert.throws(() => validatePrivateMetrics(envelope([privateRepository('101', {name})])));
  }
});

test('rejects raw private metadata at every nested boundary without echoing it', () => {
  const sentinel = 'SENSITIVE-owner/path-and-message';
  const cases = [
    data => { data.raw = sentinel; },
    data => { data.collection.message = sentinel; },
    data => { data.repositories[0].url = `https://github.com/${sentinel}`; },
    data => { data.repositories[0].inventory = {[sentinel]: {}}; },
    data => { data.repositories[0].notice = sentinel; },
    data => { data.repositories[0].name = sentinel + '/raw-file.py'; },
    data => { data.repositories[0].history[0].sha = sentinel; },
    data => { data.repositories[0].history[0].metrics.path = sentinel; },
    data => { data.repositories[0].history[0].languages[sentinel] = metrics(1); },
    data => { data.repositories[0].history[0].languages.Python.message = sentinel; },
    data => { data.repositories[0].sourceKey = 'fedcba9876543210'; },
    data => { data.repositories[0].history[0].metrics.code = -1; },
    data => { data.repositories[0].history[0].metrics.code = 0.5; },
    data => { data.repositories[0].rulesVersion = sentinel; },
    data => { data.repositories.push(structuredClone(data.repositories[0])); data.collection.repositories++; },
    data => { data.collection.repositories = 8; },
    data => { data.repositories[0].status = 'stale'; },
    data => { data.collection.failed = 1; },
  ];
  for (const mutate of cases) {
    const data = envelope();
    mutate(data);
    assert.throws(() => validatePrivateMetrics(data), error => !error.message.includes(sentinel));
  }
});

test('rejects commit-resolution timestamps, duplicate days and future private points', () => {
  for (const timestamp of ['2026-10-20T12:34:56Z', '2026-10-22T23:59:59.999999Z', '2026-10-21T03:30:00Z', '2026-02-30T23:59:59.999999Z']) {
    const data = envelope();
    data.repositories[0].history[0].timestamp = timestamp;
    assert.throws(() => validatePrivateMetrics(data));
  }
  const data = envelope();
  data.repositories[0].history.push(structuredClone(data.repositories[0].history[0]));
  assert.throws(() => validatePrivateMetrics(data));
  data.repositories[0].history[1].timestamp = data.generatedAt;
  assert.equal(validatePrivateMetrics(data), true);
});

test('merges without mutation and recalculates current-rule totals and separate snapshot counts', () => {
  const data = publicStats([publicRepository(), publicRepository('303', {status: 'cold'})]);
  const privateData = envelope([privateRepository(), privateRepository('404', {rulesVersion: 'fedcba9876543210'})]);
  const before = structuredClone({data, privateData});
  const result = mergePrivateMetrics(data, privateData);
  assert.deepEqual(result.summary, {code: 30, comment: 4, blank: 6, documentation: 8, files: 2, repositories: 2, publicRepositories: 1, privateRepositories: 1, commits: 2, snapshots: 2});
  assert.equal(result.repositories.length, 4);
  assert.deepEqual(result.publication, {privateRepositories: 2, privateUpdatedAt: privateData.generatedAt, privateSource: 'local', privateStatus: 'stale'});
  result.repositories[0].history[0].metrics.code = 999;
  assert.deepEqual({data, privateData}, before);
});

test('a current public record wins a visibility transition, while private replaces stale public history', () => {
  const data = publicStats([publicRepository('101'), publicRepository('202', {status: 'stale'})]);
  const result = mergePrivateMetrics(data, envelope([privateRepository('101'), privateRepository('202')]));
  assert.deepEqual(result.repositories.map(repository => repository.id), ['101', `private-${keyFor('202')}`]);
  assert.equal(result.summary.code, 30);
  assert.equal(result.publication.privateRepositories, 1);
  const oldRules = mergePrivateMetrics(publicStats([publicRepository('101', {rulesVersion: 'fedcba9876543210'})]), envelope());
  assert.deepEqual(oldRules.repositories.map(repository => repository.id), [`private-${keyFor('101')}`]);
});

test('rebuilding unified input replaces earlier sanitized records instead of counting them twice', () => {
  const once = mergePrivateMetrics(publicStats([publicRepository()]), envelope());
  const twice = mergePrivateMetrics(once, envelope([privateRepository('101', {history: []})]));
  assert.equal(twice.repositories.length, 2);
  assert.equal(twice.summary.code, 20);
  assert.equal(twice.repositories.find(repository => repository.visibility === 'private').history.length, 0);
});

test('a partial token scope cannot erase prior identities; verified public transitions permit removal', () => {
  const previous = envelope([privateRepository('101'), privateRepository('202')]);
  const next = envelope([privateRepository('101')]);
  const validateReplacement = metricsModule.validatePrivateMetricsReplacement;
  assert.equal(typeof validateReplacement, 'function');
  assert.throws(() => validateReplacement(previous, envelope([])), /scope/);
  assert.throws(() => validateReplacement(previous, next), /scope/);
  assert.throws(() => validateReplacement(previous, next, publicStats([publicRepository('202', {status: 'stale'})])), /scope/);
  assert.equal(validateReplacement(previous, next, publicStats([publicRepository('202')])), true);
  assert.equal(validateReplacement(next, previous), true);
});

test('adopting an incomplete scope leaves the complete durable file untouched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tally-adopt-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const baseline = join(directory, 'baseline.json');
  const candidate = join(directory, 'candidate.json');
  const publicFile = join(directory, 'public.json');
  await writeFile(baseline, JSON.stringify(envelope()));
  await writeFile(candidate, JSON.stringify(envelope([])));
  await writeFile(publicFile, JSON.stringify(publicStats([])));
  const original = await readFile(baseline, 'utf8');
  assert.equal(typeof metricsModule.adoptPrivateMetrics, 'function');
  await assert.rejects(metricsModule.adoptPrivateMetrics(baseline, candidate, publicFile), /scope/);
  assert.equal(await readFile(baseline, 'utf8'), original);
  await writeFile(publicFile, JSON.stringify(publicStats([publicRepository('101')])));
  await metricsModule.adoptPrivateMetrics(baseline, candidate, publicFile);
  assert.deepEqual(JSON.parse(await readFile(baseline)), envelope([]));
});

test('the display range includes a private scan newer than the public dataset', () => {
  const data = publicStats([publicRepository()]);
  data.generatedAt = '2026-10-21T02:00:00Z';
  const privateData = envelope();
  privateData.repositories[0].history[0].timestamp = privateData.generatedAt;
  assert.equal(mergePrivateMetrics(data, privateData).generatedAt, '2026-10-21T04:00:00Z');
});

test('private job, download and adoption failures mark retained data stale; no token preserves the baseline', () => {
  const status = metricsModule.privatePublicationStatus;
  assert.equal(typeof status, 'function');
  const states = [
    [{jobResult: 'success', scanStatus: 'not-configured', available: 'false'}, 'not-configured'],
    [{jobResult: 'failure', scanStatus: 'not-configured', available: 'false'}, 'stale'],
    [{jobResult: 'success', scanStatus: 'stale', available: 'false'}, 'stale'],
    [{jobResult: 'success', available: 'true', downloadOutcome: 'failure'}, 'stale'],
    [{jobResult: 'success', available: 'true', downloadOutcome: 'success', adoptStatus: 'stale'}, 'stale'],
    [{jobResult: 'success', available: 'true', downloadOutcome: 'success', adoptStatus: 'available'}, 'available'],
  ];
  for (const [state, expected] of states) assert.equal(status(state), expected);
});

test('older complete scans cannot overwrite newer private history, while newer LOC decreases remain valid', () => {
  const previous = envelope();
  previous.repositories[0].history[0].metrics.code = 100;
  const older = envelope();
  older.generatedAt = '2026-10-20T04:00:00Z';
  older.repositories[0].lastSuccessAt = '2026-10-20T03:00:00Z';
  older.repositories[0].history[0].timestamp = '2026-10-19T23:59:59.999999Z';
  assert.throws(() => metricsModule.validatePrivateMetricsReplacement(previous, older), /older/);
  const decrease = envelope();
  decrease.generatedAt = '2026-10-21T05:00:00Z';
  decrease.repositories[0].lastSuccessAt = '2026-10-21T04:30:00Z';
  assert.equal(metricsModule.validatePrivateMetricsReplacement(previous, decrease), true);
  assert.equal(metricsModule.validatePrivateMetricsReplacement(previous, envelope()), true);
});

test('a fresh envelope cannot hide an older repository success time or erase a known success', () => {
  const previous = envelope();
  for (const lastSuccessAt of ['2026-10-20T03:00:00Z', null]) {
    const mixed = envelope();
    mixed.generatedAt = '2026-10-21T05:00:00Z';
    mixed.repositories[0].lastSuccessAt = lastSuccessAt;
    assert.throws(() => metricsModule.validatePrivateMetricsReplacement(previous, mixed), /older/);
  }
  const precisePrevious = envelope();
  precisePrevious.generatedAt = '2026-10-21T04:00:00.000002Z';
  const preciseOlder = envelope();
  preciseOlder.generatedAt = '2026-10-21T04:00:00.000001Z';
  assert.throws(() => metricsModule.validatePrivateMetricsReplacement(precisePrevious, preciseOlder), /older/);
});

test('adopting an older scan preserves the complete newer file byte for byte', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tally-adopt-older-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const baseline = join(directory, 'baseline.json');
  const candidate = join(directory, 'candidate.json');
  const publicFile = join(directory, 'public.json');
  const previous = envelope();
  previous.repositories[0].history[0].metrics.code = 100;
  const older = envelope();
  older.generatedAt = '2026-10-20T04:00:00Z';
  older.repositories[0].lastSuccessAt = '2026-10-20T03:00:00Z';
  older.repositories[0].history[0].timestamp = '2026-10-19T23:59:59.999999Z';
  const original = JSON.stringify(previous);
  await writeFile(baseline, original);
  await writeFile(candidate, JSON.stringify(older));
  await writeFile(publicFile, JSON.stringify(publicStats([])));
  await assert.rejects(metricsModule.adoptPrivateMetrics(baseline, candidate, publicFile), /older/);
  assert.equal(await readFile(baseline, 'utf8'), original);
});

test('archived records never contribute names, history, counts or totals after merge', () => {
  const result = mergePrivateMetrics(publicStats([publicRepository('202', {status: 'archived'})]), envelope([privateRepository('101', {status: 'archived'})]));
  assert.deepEqual(result.repositories, []);
  assert.equal(result.summary.code, 0);
  assert.equal(result.publication.privateRepositories, 0);
});

test('confirmed hashed archive evidence permits private scope reduction, not arbitrary disappearance', () => {
  const previous = envelope();
  const next = {...envelope([]), archivedRepositoryKeys: [keyFor('101')]};
  assert.equal(metricsModule.validatePrivateMetricsReplacement(previous, next), true);
  assert.throws(() => metricsModule.validatePrivateMetricsReplacement(previous, {...next, archivedRepositoryKeys: []}), /scope/);
  assert.throws(() => validatePrivateMetrics({...next, archivedRepositoryKeys: ['private/name']}));
});

test('dataset epochs cannot mix and scope reset requires explicit replacement authorization', () => {
  const previous = envelope();
  const next = {...envelope([]), datasetEpoch: 'reset-test-v2', archivedRepositoryKeys: []};
  assert.throws(() => mergePrivateMetrics({...publicStats([]), datasetEpoch: 'reset-test-v2'}, previous), /epoch/i);
  assert.throws(() => metricsModule.validatePrivateMetricsReplacement(previous, next), /epoch/i);
  assert.equal(metricsModule.validatePrivateMetricsReplacement(previous, next, undefined, {resetEpoch: 'reset-test-v2'}), true);
});

function retainedBaseline(data = envelope()) {
  return {mode: 'retained-private-baseline', targetEpoch: 'reset-test-v2', sourceEpoch: data.datasetEpoch ?? null,
    sourceSnapshotSha256: 'a'.repeat(64), sourceStateCommit: 'b'.repeat(40),
    retainedSnapshotSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    scope: {source: 'github-connector/list_repositories', verifiedAt: '2026-10-21T06:00:00Z',
      activeRepositoryKeys: data.repositories.map(r => r.sourceKey), archivedRepositoryKeys: [keyFor('999')]}, metrics: data};
}

test('explicit verified retained mode counts active old private data without relabeling epoch, rules or times', () => {
  const data = {...publicStats([publicRepository()]), datasetEpoch: 'reset-test-v2', rules: {version: 'fedcba9876543210'}};
  data.repositories[0].rulesVersion = data.rules.version;
  const old = envelope();
  const baseline = retainedBaseline(old);
  assert.throws(() => mergePrivateMetrics(data, old), /epoch/i);
  const result = mergePrivateMetrics(data, old, {retainedBaseline: baseline});
  assert.equal(result.datasetEpoch, 'reset-test-v2');
  assert.equal(result.summary.code, 30);
  assert.equal(result.summary.privateRepositories, 1);
  assert.equal(result.publication.privateStatus, 'retained');
  assert.equal(result.publication.privateUpdatedAt, old.generatedAt);
  assert.equal(result.publication.privateDatasetEpoch, null);
  assert.equal(result.publication.privateRulesVersion, version);
  const privateRow = result.repositories.find(r => r.visibility === 'private');
  assert.equal(privateRow.dataFreshness, 'retained-private');
  assert.equal(privateRow.rulesVersion, version);
  assert.equal(privateRow.lastSuccessAt, old.repositories[0].lastSuccessAt);
  assert.deepEqual(privateRow.history, old.repositories[0].history);
  assert.equal(old.repositories[0].dataFreshness, undefined);
});

test('retained mode rejects unverified scope, archived keys, changed snapshots and wrong targets', () => {
  const data = {...publicStats([]), datasetEpoch: 'reset-test-v2'};
  for (const mutate of [b => b.scope.activeRepositoryKeys = [], b => b.scope.archivedRepositoryKeys.push(keyFor('101')),
    b => b.metrics.repositories[0].history[0].metrics.code++, b => b.targetEpoch = 'another',
    b => b.sourceEpoch = 'reset-test-v2', b => b.scope.verifiedAt = '2026-10-20T00:00:00Z']) {
    const baseline = retainedBaseline(); mutate(baseline);
    assert.throws(() => mergePrivateMetrics(data, baseline.metrics, {retainedBaseline: baseline}));
  }
});

test('fresh replacement of retained data must preserve verified private scope across epochs', () => {
  const old = envelope();
  const next = {...envelope([]), datasetEpoch: 'reset-test-v2'};
  assert.throws(() => metricsModule.validatePrivateMetricsReplacement(old, next, publicStats([]), {resetEpoch: 'reset-test-v2', preserveScope: true}), /scope/);
  next.archivedRepositoryKeys = [keyFor('101')];
  assert.equal(metricsModule.validatePrivateMetricsReplacement(old, next, publicStats([]), {resetEpoch: 'reset-test-v2', preserveScope: true}), true);
});

test('verified archive keys exclude a stale public visibility record as well as private records', () => {
  const privateData = {...envelope([]), archivedRepositoryKeys: [keyFor('202')]};
  const result = mergePrivateMetrics(publicStats([publicRepository('202')]), privateData);
  assert.deepEqual(result.repositories, []);
  assert.equal(result.summary.code, 0);
});

test('source-only reset ships no old private fallback or retained statistics', async () => {
  const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  const data = JSON.parse(await readFile(new URL('../web/data/stats.json', import.meta.url), 'utf8'));
  assert.equal(data.datasetEpoch, config.datasetEpoch);
  assert.equal(data.datasetEpoch, 'source-only-lineage-2026-10-21-v1');
  assert.deepEqual(data.repositories, []);
  assert.equal(data.summary.code, 0);
  assert.equal(data.summary.files, 0);
  assert.equal(data.completeness.complete, false);
  assert.equal(data.publication.privateStatus, 'pending-rebuild');
  for (const filename of ['private-metrics.json', 'retained-private-baseline.json']) {
    await assert.rejects(readFile(new URL(`../web/data/${filename}`, import.meta.url)), {code:'ENOENT'});
  }
});

const lineageVersion = 'abcdef0123456789';
function lineageRepository(overrides = {}) {
  return privateRepository('lineage:vitro', {name: 'owner/current', lastCommitDate: '2026-10-20', lineage: {
    id: 'vitro', version: lineageVersion,
    members: [{name: 'owner/old', sourceKey: keyFor('101')}, {name: 'owner/current', sourceKey: keyFor('202')}],
    dominantMember: 'owner/old', representativeMember: 'owner/current',
  }, ...overrides});
}
function lineageEnvelope(repositories = [lineageRepository()], overrides = {}) {
  return {...envelope(repositories), datasetEpoch: 'lineage-v1', lineageVersion,
    completeness: {complete: true, discoveryComplete: true, expectedRepositories: 2, scannedRepositories: 2, missingMembers: 0, failed: 0}, ...overrides};
}
const lineagePublicStats = repositories => ({...publicStats(repositories), datasetEpoch: 'lineage-v1', lineageVersion});

test('accepts only sanitized lineage identities and day-only actual update dates', () => {
  assert.equal(validatePrivateMetrics(lineageEnvelope()), true);
  assert.equal(validatePrivateMetrics(envelope([privateRepository('101', {lastCommitDate: null})])), true);
  for (const mutate of [
    d => d.repositories[0].lastCommitDate = '2026-10-20T12:34:56Z',
    d => d.repositories[0].lastCommitDate = '2026-02-30',
    d => d.repositories[0].lineage.path = 'private/source.py',
    d => d.repositories[0].lineage.members[0].sha = 'private-commit',
    d => d.repositories[0].lineage.members[0].name = 'owner/repo/file',
    d => d.repositories[0].lineage.members[0].sourceKey = 'secret',
    d => d.repositories[0].lineage.members[1] = {...d.repositories[0].lineage.members[0]},
    d => d.repositories[0].lineage.dominantMember = 'owner/not-a-member',
    d => d.repositories[0].lineage.representativeMember = 'owner/old',
    d => d.repositories[0].lineage.id = '../unsafe',
    d => d.repositories[0].lineage.version = '0000000000000000',
    d => d.repositories[0].sourceKey = keyFor('different'),
  ]) {
    const data = lineageEnvelope(); mutate(data);
    assert.throws(() => validatePrivateMetrics(data));
  }
});

test('lineage envelope rejects duplicate group/member statistics and falsified completeness', () => {
  const duplicated = lineageEnvelope([lineageRepository(), privateRepository('101')]);
  assert.throws(() => validatePrivateMetrics(duplicated));
  for (const mutate of [
    d => d.completeness.discoveryComplete = false,
    d => d.completeness.expectedRepositories = 3,
    d => d.completeness.missingMembers = 1,
    d => d.completeness.failed = 1,
    d => d.completeness.extra = 'private-detail',
    d => d.repositories[0].historyComplete = false,
    d => d.repositories[0].rulesVersion = '0000000000000000',
    d => d.repositories[0].status = 'excluded',
  ]) {
    const data = lineageEnvelope(); mutate(data);
    assert.throws(() => validatePrivateMetrics(data));
  }
});

test('a private mixed group replaces raw public members and the public partial group exactly once', () => {
  const publicGroup = publicRepository('lineage:vitro', {lineage: structuredClone(lineageRepository().lineage)});
  const data = lineagePublicStats([publicRepository('101'), publicRepository('202'), publicGroup, publicRepository('303')]);
  const result = mergePrivateMetrics(data, lineageEnvelope(), {privateStatus:'available'});
  assert.deepEqual(result.repositories.map(r => r.id), ['303', `private-${keyFor('lineage:vitro')}`]);
  assert.equal(result.summary.code, 30);
  assert.equal(result.summary.repositories, 2);
  assert.equal(result.publication.privateStatus, 'available');
});

test('lineage versions must match across sources and old retained data cannot masquerade as a fresh group', () => {
  const next = lineageEnvelope();
  assert.throws(() => mergePrivateMetrics(publicStats([]), next), /lineage/i);
  assert.throws(() => mergePrivateMetrics({...lineagePublicStats([]), lineageVersion: '0000000000000000'}, next), /lineage/i);
  assert.throws(() => mergePrivateMetrics(lineagePublicStats([]), {...envelope(), datasetEpoch: 'lineage-v1'}), /lineage/i);
  const old = envelope();
  const baseline = {...retainedBaseline(old), targetEpoch: 'lineage-v1'};
  assert.throws(() => mergePrivateMetrics(lineagePublicStats([]), old, {retainedBaseline: baseline}), /lineage/i);
});

test('incomplete lineage may be inspected but cannot be adopted or labeled available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tally-lineage-incomplete-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const baseline = join(directory, 'baseline.json'), candidate = join(directory, 'candidate.json'), publicFile = join(directory, 'public.json');
  const original = JSON.stringify(lineageEnvelope());
  await writeFile(baseline, original);
  await writeFile(publicFile, JSON.stringify(lineagePublicStats([])));
  for (const incomplete of [lineageEnvelope([], {completeness: {complete: false, discoveryComplete: false, expectedRepositories: 2, scannedRepositories: 0, missingMembers: 2, failed: 0}}), (() => {const d = lineageEnvelope(); delete d.completeness; return d;})()]) {
    assert.equal(validatePrivateMetrics(incomplete), true);
    assert.equal(mergePrivateMetrics(lineagePublicStats([]), incomplete).publication.privateStatus, 'stale');
    await writeFile(candidate, JSON.stringify(incomplete));
    await assert.rejects(metricsModule.adoptPrivateMetrics(baseline, candidate, publicFile), /incomplete/i);
    assert.equal(await readFile(baseline, 'utf8'), original);
    assert.throws(() => metricsModule.validatePrivateMetricsReplacement(lineageEnvelope(), incomplete, lineagePublicStats([])), /incomplete/i);
  }
});

test('scope preservation recognizes private group members but not genuinely missing identities', () => {
  const previous = {...envelope([privateRepository('101'), privateRepository('202')]), datasetEpoch: 'legacy-v0'};
  assert.equal(metricsModule.validatePrivateMetricsReplacement(previous, lineageEnvelope(), lineagePublicStats([]), {resetEpoch: 'lineage-v1', preserveScope: true}), true);
  const missing = {...envelope([privateRepository('101'), privateRepository('202'), privateRepository('303')]), datasetEpoch: 'legacy-v0'};
  assert.throws(() => metricsModule.validatePrivateMetricsReplacement(missing, lineageEnvelope(), lineagePublicStats([]), {resetEpoch: 'lineage-v1', preserveScope: true}), /scope/);
});

test('validate --complete rejects missing lineage proof and accepts fully fresh proof', async t => {
  const {spawnSync} = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'tally-lineage-cli-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const candidate = join(directory, 'candidate.json');
  const data = lineageEnvelope();
  await writeFile(candidate, JSON.stringify(data));
  const run = () => spawnSync(process.execPath, [new URL('./metrics.mjs', import.meta.url).pathname, 'validate', candidate, '--complete'], {encoding:'utf8'});
  assert.equal(run().status, 0);
  delete data.completeness;
  await writeFile(candidate, JSON.stringify(data));
  assert.equal(run().status, 1);
});

test('sanitized lineage accepts a deliberate singleton and matches collector safe-id syntax', () => {
  const singleton = lineageEnvelope();
  singleton.repositories[0].lineage.members = [singleton.repositories[0].lineage.members[1]];
  singleton.repositories[0].lineage.dominantMember = 'owner/current';
  assert.equal(validatePrivateMetrics(singleton), true);
  for (const id of ['with.dot', 'a'.repeat(65)]) {
    const invalid = lineageEnvelope();
    invalid.repositories[0].lineage.id = id;
    invalid.repositories[0].sourceKey = keyFor(`lineage:${id}`);
    invalid.repositories[0].id = `private-${invalid.repositories[0].sourceKey}`;
    assert.throws(() => validatePrivateMetrics(invalid));
  }
});

test('overall lineage completeness requires both jobs and retains their independent proofs', () => {
  const privateData = lineageEnvelope();
  const data = {...lineagePublicStats([]), completeness: {complete: true, discoveryComplete: true, expectedRepositories: 3, scannedRepositories: 3, missingMembers: 0, failed: 0}};
  const result = mergePrivateMetrics(data, privateData, {privateStatus:'available'});
  assert.deepEqual(result.publication.publicCompleteness, data.completeness);
  assert.deepEqual(result.publication.privateCompleteness, privateData.completeness);
  assert.deepEqual(result.completeness, {complete: true, discoveryComplete: true, expectedRepositories: 5, scannedRepositories: 5, missingMembers: 0, failed: 0});
  result.publication.privateCompleteness.complete = false;
  assert.equal(privateData.completeness.complete, true, 'proofs must be copied, not referenced');
  const pending = mergePrivateMetrics({...data, completeness: {...data.completeness, complete: false, discoveryComplete: false, scannedRepositories: 1, missingMembers: 1, failed: 1}}, privateData, {privateStatus:'available'});
  assert.equal(pending.publication.privateStatus, 'available', 'private job status is independent');
  assert.deepEqual(pending.completeness, {complete: false, discoveryComplete: false, expectedRepositories: 5, scannedRepositories: 3, missingMembers: 1, failed: 1});
  const unproven = mergePrivateMetrics(lineagePublicStats([]), privateData);
  assert.equal(unproven.completeness.complete, false);
  assert.equal(unproven.publication.publicCompleteness, null);
});

test('a contradictory public completeness claim cannot make a new lineage dataset fresh', () => {
  const data = {...lineagePublicStats([]), completeness: {complete: true, discoveryComplete: true, expectedRepositories: 3, scannedRepositories: 2, missingMembers: 0, failed: 0}};
  assert.throws(() => mergePrivateMetrics(data, lineageEnvelope()), /Invalid/);
});

test('current private attempt failure cannot reuse a retained snapshot proof as current completeness', () => {
  const privateData = lineageEnvelope();
  const publicData = {...lineagePublicStats([]), completeness:{complete:true, discoveryComplete:true, expectedRepositories:3, scannedRepositories:3, missingMembers:0, failed:0}};
  for (const privateStatus of ['stale', 'not-configured']) {
    const result = mergePrivateMetrics(publicData, privateData, {privateStatus});
    assert.equal(result.publication.privateStatus, 'stale');
    assert.equal(result.publication.privateAttemptStatus, privateStatus);
    assert.equal(result.publication.privateCompleteness, null, 'no proof for the unsuccessful current attempt');
    assert.deepEqual(result.publication.privateSnapshotCompleteness, privateData.completeness, 'prior complete proof retained only as snapshot provenance');
    assert.equal(result.completeness.complete, false);
    assert.equal(result.completeness.discoveryComplete, false);
    assert.equal(result.publication.privateUpdatedAt, privateData.generatedAt);
    assert.deepEqual(privateData.completeness, lineageEnvelope().completeness);
  }
  const fresh = mergePrivateMetrics(publicData, privateData, {privateStatus:'available'});
  assert.equal(fresh.completeness.complete, true);
  assert.equal(fresh.publication.privateCompleteness.complete, true);
});

const blobSha = value => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
test('explicit external snapshot proves only exact sanitized bytes under current contracts', () => {
  const privateData = lineageEnvelope();
  const publicData = {...lineagePublicStats([]), completeness:{complete:true, discoveryComplete:true, expectedRepositories:0, scannedRepositories:0, missingMembers:0, failed:0}};
  const privateBytes = Buffer.from(JSON.stringify(privateData, null, 2) + '\n');
  const externalPrivateBlobSha = blobSha(privateBytes);
  const result = mergePrivateMetrics(publicData, privateData, {privateStatus:'not-configured', externalPrivateBlobSha, privateBytes});
  assert.equal(result.publication.privateAttemptStatus, 'external-verified');
  assert.equal(result.publication.privateStatus, 'available');
  assert.equal(result.publication.privateSnapshotBlobSha, externalPrivateBlobSha);
  assert.equal(result.completeness.complete, true);
  assert.deepEqual(result.publication.privateCompleteness, privateData.completeness);
  assert.equal(mergePrivateMetrics({...publicData, completeness:{...publicData.completeness,complete:false}}, privateData, {privateStatus:'stale', externalPrivateBlobSha, privateBytes}).completeness.complete, false);
  for (const mutation of [
    options => options.externalPrivateBlobSha = 'f'.repeat(40),
    options => options.externalPrivateBlobSha = 'not-a-sha',
    options => options.privateBytes = Buffer.from(JSON.stringify(privateData)),
    options => delete options.privateBytes,
  ]) {
    const options = {privateStatus:'not-configured', externalPrivateBlobSha, privateBytes}; mutation(options);
    assert.throws(() => mergePrivateMetrics(publicData, privateData, options), /external|blob|snapshot/i);
  }
  assert.throws(() => mergePrivateMetrics(publicData, privateData, {privateStatus:'external-verified'}), /status|external/i);
  for (const mutate of [
    data => data.datasetEpoch = 'old-epoch',
    data => data.lineageVersion = '0000000000000000',
    data => data.rules.version = '0000000000000000',
    data => delete data.datasetEpoch,
    data => delete data.lineageVersion,
  ]) {
    const data = structuredClone(publicData); mutate(data);
    assert.throws(() => mergePrivateMetrics(data, privateData, {externalPrivateBlobSha, privateBytes}), /epoch|lineage|rules/i);
  }
  const incomplete = lineageEnvelope([], {completeness:{complete:false,discoveryComplete:false,expectedRepositories:2,scannedRepositories:0,missingMembers:2,failed:0}});
  const incompleteBytes = Buffer.from(JSON.stringify(incomplete));
  assert.throws(() => mergePrivateMetrics(publicData, incomplete, {externalPrivateBlobSha:blobSha(incompleteBytes),privateBytes:incompleteBytes}), /incomplete/i);
});

test('lineage snapshot without a current-attempt signal is not automatically fresh', () => {
  const privateData = lineageEnvelope();
  const publicData = {...lineagePublicStats([]), completeness:{complete:true,discoveryComplete:true,expectedRepositories:0,scannedRepositories:0,missingMembers:0,failed:0}};
  const result = mergePrivateMetrics(publicData, privateData);
  assert.equal(result.publication.privateAttemptStatus, 'not-configured');
  assert.equal(result.publication.privateStatus, 'stale');
  assert.equal(result.publication.privateCompleteness, null);
  assert.deepEqual(result.publication.privateSnapshotCompleteness, privateData.completeness);
  assert.equal(result.completeness.complete, false);
});
