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
