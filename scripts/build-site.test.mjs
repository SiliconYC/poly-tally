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
