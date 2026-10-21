import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateHistory, selectRepositories, latestTotals, languageTotals, loadStats } from './model.mjs';

const metrics = (code, documentation = 0) => ({ code, comment: 0, blank: 0, documentation, files: 1 });
const snapshot = (timestamp, code, language = 'Python', documentation = 0) => ({
  sha: `${timestamp}-${code}`, timestamp, committedAt: timestamp, authoredAt: timestamp,
  metrics: metrics(code, documentation), languages: { [language]: metrics(code, documentation) },
});
const repo = (id, history, extra = {}) => ({ id, name: `owner/${id}`, url: `https://github.com/owner/${id}`, branch: 'main', head: 'abc123', status: 'active', lastSuccessAt: '2026-10-21T00:00:00Z', rulesVersion: 'v1', historyComplete: true, notice: '', history, ...extra });
const day = n => `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`;
const dataset = repositories => ({ schemaVersion: 1, generatedAt: day(21), rules: { version: 'v1', description: '统一规则' }, collector: { version: '1' }, summary: {}, repositories, runs: [] });

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
