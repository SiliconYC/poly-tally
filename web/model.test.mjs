import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateHistory, selectRepositories, latestTotals, languageTotals, loadStats } from './model.mjs';
import * as model from './model.mjs';

const metrics = (code, documentation = 0) => ({ code, comment: 0, blank: 0, documentation, files: 1 });
const snapshot = (timestamp, code, language = 'Python', documentation = 0) => ({
  sha: `${timestamp}-${code}`, timestamp, committedAt: timestamp, authoredAt: timestamp,
  metrics: metrics(code, documentation), languages: { [language]: metrics(code, documentation) },
});
const repo = (id, history, extra = {}) => ({ id, name: `owner/${id}`, url: `https://github.com/owner/${id}`, branch: 'main', head: 'abc123', status: 'active', lastSuccessAt: '2026-10-21T00:00:00Z', rulesVersion: 'v1', historyComplete: true, notice: '', history, ...extra });
const day = n => `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`;
const dataset = repositories => ({ schemaVersion: 1, generatedAt: day(21), rules: { version: 'v1', description: '统一规则' }, collector: { version: '1' }, summary: {}, repositories, runs: [] });
const privateRepo = (code = 30, extra = {}) => repo('private-0123456789abcdef', [{ timestamp: day(20), metrics: metrics(code), languages: { Rust: metrics(code) } }], {
  name: '私有仓库 · 012345', url: null, branch: null, head: null, visibility: 'private', sourceKey: '0123456789abcdef', snapshotKind: 'daily', ...extra,
});

test('visibility scopes consistently select public commits and private daily metrics under the same rules', () => {
  const data = dataset([repo('a', [snapshot(day(1), 10)]), privateRepo(), privateRepo(900, { id: 'private-fedcba9876543210', rulesVersion: 'old' })]);
  const all = selectRepositories(data);
  const publicOnly = selectRepositories(data, { scope: 'public' });
  const privateOnly = selectRepositories(data, { scope: 'private' });
  assert.deepEqual(all.map(r => r.id), ['a', 'private-0123456789abcdef']);
  assert.deepEqual(publicOnly.map(r => r.id), ['a']);
  assert.deepEqual(privateOnly.map(r => r.id), ['private-0123456789abcdef']);
  assert.equal(latestTotals(all).code, 40);
  assert.equal(latestTotals(privateOnly).code, 30);
  assert.deepEqual(languageTotals(privateOnly), [{ name: 'Rust', value: 30 }]);
  assert.deepEqual(aggregateHistory(privateOnly).map(p => [p.timestamp, p.value]), [[day(20), 30]]);
  assert.deepEqual(selectRepositories(data, { scope: 'private', ids: ['a'] }), []);
});

test('publication summary counts mixed repositories without treating public refresh as a private update', () => {
  const data = dataset([repo('a', [snapshot(day(1), 10)]), privateRepo()]);
  data.publication = { privateRepositories: 1, privateUpdatedAt: day(20), privateSource: 'local', privateStatus: 'stale' };
  assert.deepEqual(model.publicationSummary?.(data), { publicRepositories: 1, privateRepositories: 1, privateUpdatedAt: day(20), privateStatus: 'stale', privateSource: 'local' });
  assert.deepEqual(model.publicationSummary?.(dataset([])), { publicRepositories: 0, privateRepositories: 0, privateUpdatedAt: null, privateStatus: 'not-configured', privateSource: null });
  assert.deepEqual(model.publicationSummary?.(dataset([privateRepo()])), { publicRepositories: 0, privateRepositories: 1, privateUpdatedAt: null, privateStatus: 'stale', privateSource: null });
});

test('load accepts anonymous daily private snapshots without any commit fields and rejects private commit details', async () => {
  const data = dataset([privateRepo()]);
  const load = value => loadStats(async () => ({ ok: true, json: async () => value }));
  assert.deepEqual(await load(data), data);
  await assert.rejects(() => load(dataset([privateRepo(30, { head: 'secret-sha' })])), /数据/);
  const exposed = privateRepo();
  exposed.history[0].sha = 'secret-sha';
  await assert.rejects(() => load(dataset([exposed])), /数据/);
});

test('three repositories align with carry-forward stock, not summed commit increments', () => {
  const repositories = [repo('a', [snapshot(day(1), 10), snapshot(day(3), 16)]), repo('b', [snapshot(day(2), 20)]), repo('c', [snapshot(day(3), 4), snapshot(day(4), 2)])];
  assert.deepEqual(aggregateHistory(repositories).map(p => [p.timestamp, p.value]), [[day(1), 10], [day(2), 30], [day(3), 40], [day(4), 38]]);
  assert.equal(latestTotals(repositories).code, 38);
});

test('same timestamp resolves the final snapshot per repository before emitting an aggregate', () => {
  const repositories = [repo('a', [snapshot(day(1), 3), snapshot(day(1), 9)]), repo('b', [snapshot(day(1), 8)])];
  assert.deepEqual(aggregateHistory(repositories).map(p => p.value), [17]);
});

test('current totals exclude cold, old rules and failed states; explicit stale inclusion stays same-rule', () => {
  const data = dataset(['active', 'archived', 'cold', 'stale', 'inaccessible', 'empty', 'excluded'].map((status, i) => repo(String(i), [snapshot(day(1), 10)], { status })).concat(repo('old', [snapshot(day(1), 900)], { rulesVersion: 'old' })));
  assert.deepEqual(selectRepositories(data).map(r => r.id), ['0', '1']);
  assert.deepEqual(selectRepositories(data, { mode: 'archive' }).map(r => r.id), ['0', '1', '2']);
  assert.deepEqual(selectRepositories(data, { includeStale: true }).map(r => r.id), ['0', '1', '3', '4']);
  assert.deepEqual(selectRepositories(data, { ids: ['1', '2'] }).map(r => r.id), ['1']);
  assert.deepEqual(selectRepositories(data, { ids: [] }), []);
});

test('language and metric selection consistently affects timeline and latest totals', () => {
  const repositories = [repo('a', [snapshot(day(1), 10, 'Python', 7)]), repo('b', [snapshot(day(1), 20, 'JavaScript', 2)])];
  assert.deepEqual(aggregateHistory(repositories, { language: 'Python', metric: 'documentation' }).map(p => p.value), [7]);
  assert.equal(latestTotals(repositories, 'Python').code, 10);
  assert.deepEqual(languageTotals(repositories, 'code'), [{ name: 'JavaScript', value: 20 }, { name: 'Python', value: 10 }]);
});

test('period boundary preserves the last stock before the window and sorts by real UTC time', () => {
  const repositories = [repo('a', [snapshot(day(20), 20), snapshot(day(1), 10), snapshot('2026-10-21T09:00:00+08:00', 30)])];
  const points = aggregateHistory(repositories, { since: day(19), until: '2026-10-21T02:00:00Z' });
  assert.deepEqual(points.map(p => p.value), [10, 20, 30, 30]);
  assert.equal(points[0].timestamp, day(19));
  assert.equal(points[2].timestamp, '2026-10-21T01:00:00Z');
  assert.equal(points.at(-1).timestamp, '2026-10-21T02:00:00Z');
});

test('empty selection and an absent language are honest zeros without fabricated observations', () => {
  assert.deepEqual(aggregateHistory([]), []);
  assert.equal(latestTotals([]).code, 0);
  assert.deepEqual(languageTotals([], 'code'), []);
  assert.equal(latestTotals([repo('a', [snapshot(day(1), 7)])], 'Rust').code, 0);
});

test('load rejects unavailable, malformed or unsupported data and accepts valid empty exports', async () => {
  await assert.rejects(() => loadStats(async () => ({ ok: false, status: 404 })), /404/);
  await assert.rejects(() => loadStats(async () => ({ ok: true, json: async () => ({ schemaVersion: 9 }) })), /版本/);
  await assert.rejects(() => loadStats(async () => ({ ok: true, json: async () => ({ schemaVersion: 1, repositories: [{}] }) })), /数据/);
  assert.deepEqual(await loadStats(async () => ({ ok: true, json: async () => dataset([]) })), dataset([]));
});

test('repository sorting handles names, selected metric, dates and unavailable values without mutating source', () => {
  const repositories = [repo('b', [snapshot(day(1), 20, 'Python', 3)], { lastSuccessAt: null }), repo('a', [snapshot(day(1), 5, 'Python', 9)], { lastSuccessAt: day(2) }), repo('c', [], { lastSuccessAt: day(1) })];
  assert.deepEqual(model.sortRepositories?.(repositories, { key: 'name' }).map(r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(model.sortRepositories?.(repositories, { key: 'metric', direction: 'desc', metric: 'documentation' }).map(r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(model.sortRepositories?.(repositories, { key: 'updated', direction: 'asc' }).map(r => r.id), ['c', 'a', 'b']);
  assert.deepEqual(model.sortRepositories?.(repositories, { key: 'updated', direction: 'desc' }).map(r => r.id), ['a', 'c', 'b']);
  assert.deepEqual(repositories.map(r => r.id), ['b', 'a', 'c']);
});

test('picker searches full repository names and sorts scale by the selected language and metric', () => {
  const repositories = [repo('alpha', [snapshot(day(1), 20, 'Python', 1)]), repo('beta', [snapshot(day(1), 5, 'Rust', 8)])];
  assert.deepEqual(model.repositoryOptions?.(repositories, { query: ' OWNER/ALP ' }).map(r => r.id), ['alpha']);
  assert.deepEqual(model.repositoryOptions?.(repositories, { key: 'metric', direction: 'desc', metric: 'documentation' }).map(r => r.id), ['beta', 'alpha']);
  assert.deepEqual(model.repositoryOptions?.(repositories, { key: 'metric', direction: 'desc', language: 'Python' }).map(r => r.id), ['alpha', 'beta']);
});

test('period change uses real stock at the window boundary and the chosen metric', () => {
  const repositories = [repo('a', [snapshot(day(1), 10, 'Python', 5), snapshot(day(20), 18, 'Python', 3)]), repo('b', [snapshot(day(1), 20, 'Rust', 2), snapshot(day(21), 21, 'Rust', 7)])];
  assert.deepEqual(model.stockChange?.(repositories, { since: day(19), until: day(20), metric: 'documentation' }), { baseline: 7, latest: 5, change: -2, missing: 0 });
  assert.deepEqual(model.stockChange?.(repositories, { since: day(19), until: day(21), language: 'Python' }), { baseline: 10, latest: 18, change: 8, missing: 0 });
});

test('period change does not pretend that missing earlier stock was zero', () => {
  const repositories = [repo('a', [snapshot(day(20), 20)])];
  assert.deepEqual(model.stockChange?.(repositories, { since: day(19), until: day(21) }), { baseline: null, latest: 20, change: null, missing: 1 });
  assert.deepEqual(model.stockChange?.([], { since: day(19), until: day(21) }), { baseline: null, latest: 0, change: null, missing: 0 });
  assert.deepEqual(model.stockChange?.(repositories, { since: day(20), until: day(21) }), { baseline: 20, latest: 20, change: 0, missing: 0 });
});

test('language overview supports ascending scale and reversible name ordering', () => {
  const repositories = [repo('a', [snapshot(day(1), 10, 'Python')]), repo('b', [snapshot(day(1), 20, 'Rust')])];
  assert.deepEqual(languageTotals(repositories, 'code', { key: 'value', direction: 'asc' }).map(row => row.name), ['Python', 'Rust']);
  assert.deepEqual(languageTotals(repositories, 'code', { key: 'name', direction: 'desc' }).map(row => row.name), ['Rust', 'Python']);
});
