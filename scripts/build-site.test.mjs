import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const envelope = {schemaVersion: 1, generatedAt: '2026-10-21T04:00:00Z', rulesVersion: '0123456789abcdef', source: 'local', collection: {repositories: 0, failed: 0}, repositories: []};
const publicStats = {schemaVersion: 1, generatedAt: '2026-10-21T05:00:00Z', rules: {version: '0123456789abcdef'}, repositories: []};
async function fixture(t, privateData) {
  const root = await mkdtemp(join(tmpdir(), 'tally-build-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'web/data'), {recursive: true});
  await writeFile(join(root, 'web/data/stats.json'), JSON.stringify(publicStats));
  await writeFile(join(root, 'web/index.html'), '<main>Dashboard</main>');
  await writeFile(join(root, 'web/model.test.mjs'), 'test-only');
  if (privateData) await writeFile(join(root, 'web/data/private-metrics.json'), JSON.stringify(privateData));
  return root;
}

test('site merges a validated sanitized snapshot and omits standalone source/test files', async t => {
  const root = await fixture(t, envelope);
  const {buildSite} = await import('./build-site.mjs');
  await buildSite({root, logger: {log() {}}});
  const result = JSON.parse(await readFile(join(root, 'site/data/stats.json')));
  assert.equal(result.publication.privateUpdatedAt, envelope.generatedAt);
  assert.equal(result.publication.privateSource, 'local');
  assert.equal(await readFile(join(root, 'site/index.html'), 'utf8'), '<main>Dashboard</main>');
  await assert.rejects(access(join(root, 'site/data/private-metrics.json')));
  await assert.rejects(access(join(root, 'site/model.test.mjs')));
});

test('site retains public-only mode when no private snapshot is configured', async t => {
  const root = await fixture(t);
  const {buildSite} = await import('./build-site.mjs');
  await buildSite({root, logger: {log() {}}});
  assert.deepEqual(JSON.parse(await readFile(join(root, 'site/data/stats.json'))), publicStats);
});

test('invalid private data is rejected before replacing a previous site', async t => {
  const root = await fixture(t, {...envelope, rawSource: 'SENSITIVE-private/path'});
  await mkdir(join(root, 'site'));
  await writeFile(join(root, 'site/index.html'), 'previous-safe-site');
  const {buildSite} = await import('./build-site.mjs');
  await assert.rejects(buildSite({root, logger: {log() {}}}), error => !error.message.includes('SENSITIVE'));
  assert.equal(await readFile(join(root, 'site/index.html'), 'utf8'), 'previous-safe-site');
});

test('private collection failure marks the retained durable snapshot stale without rewriting it', async t => {
  const root = await fixture(t, envelope);
  const {buildSite} = await import('./build-site.mjs');
  await buildSite({root, privateStatus: 'stale', logger: {log() {}}});
  const result = JSON.parse(await readFile(join(root, 'site/data/stats.json')));
  assert.equal(result.publication.privateStatus, 'stale');
  assert.equal(result.publication.privateUpdatedAt, envelope.generatedAt);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'web/data/private-metrics.json'))), envelope);
});

test('content-versioned filenames cover CSS, entry and nested ESM imports consistently', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'web/charts'));
  const index = '<link href="./styles.css" rel="stylesheet"><script type="module" src="./app.mjs"></script>';
  await writeFile(join(root, 'web/index.html'), index);
  await writeFile(join(root, 'web/styles.css'), ':root{--bg:#f5f5f0}');
  await writeFile(join(root, 'web/app.mjs'), `import {plot} from './charts/plot.mjs'; import('./model.mjs'); fetch('./data/stats.json');`);
  await writeFile(join(root, 'web/charts/plot.mjs'), `export {model as plot} from '../model.mjs';`);
  await writeFile(join(root, 'web/model.mjs'), 'export const model = 1;');
  const {buildSite} = await import('./build-site.mjs');
  const build = () => buildSite({root, logger: {log() {}}});
  await build();
  const html = await readFile(join(root, 'site/index.html'), 'utf8');
  const version = html.match(/styles\.([a-f0-9]{16})\.css/)[1];
  assert.ok(html.includes(`./app.${version}.mjs`));
  const entry = await readFile(join(root, `site/app.${version}.mjs`), 'utf8');
  assert.ok(entry.includes(`./charts/plot.${version}.mjs`));
  assert.ok(entry.includes(`import('./model.${version}.mjs')`));
  assert.ok(entry.includes(`fetch('./data/stats.json')`));
  assert.ok((await readFile(join(root, `site/charts/plot.${version}.mjs`), 'utf8')).includes(`../model.${version}.mjs`));
  await assert.rejects(access(join(root, 'site/styles.css')));
  await assert.rejects(access(join(root, 'site/app.mjs')));
  assert.equal(await readFile(join(root, 'web/index.html'), 'utf8'), index, 'source HTML remains usable in local dev');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'site/data/stats.json'))), publicStats);
  await build();
  assert.equal(await readFile(join(root, 'site/index.html'), 'utf8'), html, 'identical assets yield identical URLs');
  await writeFile(join(root, 'web/styles.css'), ':root{--bg:#ffffff}');
  await build();
  const next = await readFile(join(root, 'site/index.html'), 'utf8');
  assert.notEqual(next, html, 'CSS-only changes invalidate the entire module and style release');
  assert.ok(!next.includes(version));
  await assert.rejects(access(join(root, `site/app.${version}.mjs`)), 'old build artifacts do not leak into the release');
});

test('new public epoch rejects an old bundled private fallback without rewriting site', async t => {
  const root = await fixture(t, envelope);
  await writeFile(join(root, 'web/data/stats.json'), JSON.stringify({...publicStats, datasetEpoch: 'reset-test-v2'}));
  const {buildSite} = await import('./build-site.mjs');
  await assert.rejects(buildSite({root, logger: {log() {}}}), /epoch/i);
});

test('public rebuild explicitly remains pending while private fresh data is unavailable', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'web/data/stats.json'), JSON.stringify({...publicStats, datasetEpoch: 'reset-test-v2'}));
  const {buildSite} = await import('./build-site.mjs');
  const result = await buildSite({root, logger: {log() {}}});
  assert.equal(result.publication.privateStatus, 'pending-rebuild');
  assert.equal(result.publication.privateUpdatedAt, null);
  assert.equal(result.publication.privateRepositories, 0);
});

test('explicit retained baseline restores default private totals and fresh same-epoch collection supersedes it', async t => {
  const {createHash} = await import('node:crypto');
  const {selectRepositories, latestTotals} = await import('../web/model.mjs');
  const {buildSite} = await import('./build-site.mjs');
  const sourceKey = '0123456789abcdef';
  const row = {id: `private-${sourceKey}`, sourceKey, name: `私有仓库 · ${sourceKey.slice(0, 6)}`, visibility: 'private', snapshotKind: 'daily', url: null, branch: null, head: null,
    status: 'active', lastSuccessAt: envelope.generatedAt, rulesVersion: envelope.rulesVersion, historyComplete: true, notice: '私有仓库：仅公开按日规模，不公开源码与提交详情。', skippedFiles: 0,
    history: [{timestamp: envelope.generatedAt, metrics: {code: 10, comment: 0, blank: 0, documentation: 0, files: 1}, languages: {}}]};
  const old = {...envelope, collection: {repositories: 1, failed: 0}, repositories: [row]};
  const baseline = {mode: 'retained-private-baseline', targetEpoch: 'reset-test-v2', sourceEpoch: null, sourceSnapshotSha256: 'a'.repeat(64), sourceStateCommit: 'b'.repeat(40),
    retainedSnapshotSha256: createHash('sha256').update(JSON.stringify(old)).digest('hex'),
    scope: {source: 'github-connector/list_repositories', verifiedAt: '2026-10-21T06:00:00Z', activeRepositoryKeys: [sourceKey], archivedRepositoryKeys: []}, metrics: old};
  const root = await fixture(t);
  await writeFile(join(root, 'web/data/stats.json'), JSON.stringify({...publicStats, datasetEpoch: baseline.targetEpoch, rules: {version: 'fedcba9876543210'}}));
  const retainedPath = join(root, 'web/data/retained-private-baseline.json');
  await writeFile(retainedPath, JSON.stringify(baseline));
  const retained = await buildSite({root, privateStatus: 'stale', logger: {log() {}}});
  assert.equal(retained.publication.privateStatus, 'retained');
  assert.equal(retained.publication.privateUpdatedAt, old.generatedAt);
  assert.equal(latestTotals(selectRepositories(retained)).code, 10);
  await assert.rejects(access(join(root, 'site/data/retained-private-baseline.json')));
  const fresh = structuredClone(old);
  fresh.datasetEpoch = baseline.targetEpoch;
  fresh.rulesVersion = 'fedcba9876543210';
  fresh.repositories[0].rulesVersion = fresh.rulesVersion;
  fresh.generatedAt = '2026-10-21T07:00:00Z';
  fresh.repositories[0].lastSuccessAt = fresh.generatedAt;
  fresh.repositories[0].history[0].timestamp = fresh.generatedAt;
  fresh.repositories[0].history[0].metrics.code = 20;
  await writeFile(join(root, 'web/data/private-metrics.json'), JSON.stringify(fresh));
  const rebuilt = await buildSite({root, logger: {log() {}}});
  assert.equal(rebuilt.publication.privateStatus, 'available');
  assert.equal(rebuilt.publication.privateUpdatedAt, fresh.generatedAt);
  assert.equal(latestTotals(selectRepositories(rebuilt)).code, 20);
  assert.equal(rebuilt.repositories[0].dataFreshness, undefined);
  const shrunk = {...fresh, collection: {repositories: 0, failed: 0}, repositories: []};
  await writeFile(join(root, 'web/data/private-metrics.json'), JSON.stringify(shrunk));
  await assert.rejects(buildSite({root, logger: {log() {}}}), /scope/);
  await rm(join(root, 'web/data/private-metrics.json'));
  await writeFile(join(root, 'web/data/stats.json'), JSON.stringify({...publicStats, datasetEpoch: 'later-reset-v3'}));
  const laterReset = await buildSite({root, logger: {log() {}}});
  assert.equal(laterReset.publication.privateStatus, 'pending-rebuild');
  assert.equal(laterReset.publication.privateRepositories, 0, 'explicit v2 retention cannot silently cross into a later reset');
});

test('nested preview HTML rewrites its own assets and parent imports while preserving synthetic data', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'web/qa-lineage/data'), {recursive:true});
  await mkdir(join(root, 'web/qa-lineage/details'));
  await writeFile(join(root, 'web/styles.css'), 'body{color:black}');
  await writeFile(join(root, 'web/app.mjs'), 'export const production = true;');
  const nested = '<link href="./styles.css" rel="stylesheet"><script type="module" src="./app.mjs"></script>';
  await writeFile(join(root, 'web/qa-lineage/index.html'), nested);
  await writeFile(join(root, 'web/qa-lineage/details/index.html'), '<script type="module" src="../app.mjs"></script><link href="../../styles.css" rel="stylesheet">');
  await writeFile(join(root, 'web/qa-lineage/styles.css'), 'body{color:green}');
  await writeFile(join(root, 'web/qa-lineage/app.mjs'), `import '../app.mjs'; fetch('./data/stats.json');`);
  const synthetic = {schemaVersion:1,synthetic:true,repositories:[{name:'Synthetic/repository'}]};
  await writeFile(join(root, 'web/qa-lineage/data/stats.json'), JSON.stringify(synthetic));
  const {buildSite} = await import('./build-site.mjs');
  await buildSite({root,logger:{log(){}}});
  const html = await readFile(join(root,'site/qa-lineage/index.html'),'utf8');
  const version = html.match(/styles\.([a-f0-9]{16})\.css/)?.[1];
  assert.ok(version,'nested HTML must reference built versioned styles, never removed source names');
  assert.ok(html.includes(`./app.${version}.mjs`));
  assert.match(await readFile(join(root,`site/qa-lineage/app.${version}.mjs`),'utf8'), new RegExp(`\\.\\./app\\.${version}\\.mjs`));
  const deep = await readFile(join(root,'site/qa-lineage/details/index.html'),'utf8');
  assert.ok(deep.includes(`../app.${version}.mjs`)); assert.ok(deep.includes(`../../styles.${version}.css`));
  assert.deepEqual(JSON.parse(await readFile(join(root,'site/qa-lineage/data/stats.json'))),synthetic);
  assert.deepEqual(JSON.parse(await readFile(join(root,'site/data/stats.json'))),publicStats);
  assert.equal(await readFile(join(root,'web/qa-lineage/index.html'),'utf8'),nested);
  assert.equal(await readFile(join(root,'site/index.html'),'utf8'),'<main>Dashboard</main>');
});
