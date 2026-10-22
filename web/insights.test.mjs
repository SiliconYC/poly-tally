import test from 'node:test';
import assert from 'node:assert/strict';
import * as insights from './insights.mjs';
const metrics = code => ({code, comment: 2, blank: 3, documentation: 4, files: 1});
const snap = (timestamp, code) => ({timestamp, metrics: metrics(code), languages: {Python: metrics(code)}});
const repo = (name, history) => ({name, id: name, history, visibility:'public'});

test('monthly net changes exclude unknown opening stock but retain decreases and comparable counts', () => {
  const repos = [repo('owner/old', [snap('2026-08-31T23:59:00Z', 10), snap('2026-09-30T23:59:00Z', 8), snap('2026-10-01T00:00:00Z', 15)]), repo('owner/new', [snap('2026-09-10T00:00:00Z', 100), snap('2026-10-15T00:00:00Z', 110)])];
  const result = insights.monthlyChanges?.(repos, {since:'2026-09-01T00:00:00Z', until:'2026-10-21T00:00:00Z'});
  assert.deepEqual(result?.map(m => [m.month, m.change, m.compared, m.missing]), [['2026-09', -2, 1, 1], ['2026-10', 17, 2, 0]]);
  assert.equal(result?.[1].partial, true);
  assert.equal(result?.[0].partial, false);
});

test('monthly windows cross year boundaries, clip the selected range and preserve no-baseline gaps', () => {
  const repos = [repo('owner/new', [snap('2025-12-10T00:00:00Z', 5), snap('2026-01-20T00:00:00Z', 8)])];
  const result = insights.monthlyChanges?.(repos, {since:'2025-12-01T00:00:00Z', until:'2026-01-21T00:00:00Z'});
  assert.deepEqual(result?.map(m => [m.month, m.change, m.compared]), [['2025-12', null, 0], ['2026-01', 3, 1]]);
  assert.deepEqual(insights.monthlyChanges?.([], {until:'2026-01-01T00:00:00Z'}), []);
  assert.equal(insights.monthlyChanges?.(repos, {until:'2026-01-21T00:00:00Z', limit:1}).length, 1);
});

test('CSV follows the displayed row order, includes all line categories and escapes spreadsheet formulas', () => {
  const repos = [repo('owner/hello,"world', [snap('2026-01-01T00:00:00Z', 10)]), repo('owner/=unsafe', [snap('2026-01-01T00:00:00Z', 0)])];
  const csv = insights.repositoryCsv?.(repos, 'Python');
  assert.equal(csv, '\ufeff仓库,可见性,语言,总行数,代码行,注释行,文档行,空行,文件数\r\n"hello,""world",公开,Python,19,10,2,4,3,1\r\n\'=unsafe,公开,Python,9,0,2,4,3,1\r\n');
});


test('daily changes retain negative stock changes, exact boundary events, and unknown opening stock', () => {
  const repositories = [repo('owner/one', [snap('2026-10-01T00:00:00Z', 10), snap('2026-10-02T00:00:00Z', 15), snap('2026-10-03T12:00:00Z', 9)])];
  const rows = insights.periodChanges?.(repositories, {period: 'day', since: '2026-10-01T00:00:00Z', until: '2026-10-03T23:59:59.999Z'});
  assert.deepEqual(rows?.map(row => [row.period, row.key, row.label, row.change, row.compared, row.missing, row.partial]), [
    ['day', '2026-10-01', '2026-10-01', null, 0, 1, false],
    ['day', '2026-10-02', '2026-10-02', 5, 1, 0, false],
    ['day', '2026-10-03', '2026-10-03', -6, 1, 0, false],
  ]);
});

test('weekly changes use Monday UTC starts and handle weeks crossing a year', () => {
  const repositories = [repo('owner/one', [snap('2025-12-28T23:59:00Z', 10), snap('2025-12-31T12:00:00Z', 15), snap('2026-01-05T00:00:00Z', 13)])];
  const rows = insights.periodChanges?.(repositories, {period: 'week', since: '2025-12-29T00:00:00Z', until: '2026-01-06T12:00:00Z'});
  assert.deepEqual(rows?.map(row => [row.key, row.change, row.partial]), [['2025-12-29', 5, false], ['2026-01-05', -2, true]]);
  assert.equal(rows?.[0].since, '2025-12-29T00:00:00.000Z');
  assert.equal(rows?.[0].until, '2026-01-04T23:59:59.999Z');
});

test('all periods compare selected metric and language, including file decreases', () => {
  const before = snap('2026-01-01T23:59:59Z', 5), after = snap('2026-01-02T12:00:00Z', 9);
  before.metrics = before.languages.Python = {code: 5, comment: 7, documentation: 11, blank: 2, files: 4};
  after.metrics = after.languages.Python = {code: 9, comment: 3, documentation: 15, blank: 3, files: 2};
  const repositories = [repo('owner/one', [before, after])];
  for (const [metric, expected] of [['code', 4], ['comment', -4], ['documentation', 4], ['files', -2]]) {
    const rows = insights.periodChanges?.(repositories, {period: 'day', since: '2026-01-02T00:00:00Z', until: '2026-01-02T23:59:59.999Z', metric, language: 'Python'});
    assert.equal(rows?.[0].change, expected, metric);
  }
  assert.equal(insights.periodChanges?.(repositories, {period: 'day', since: '2026-01-02T00:00:00Z', until: '2026-01-02T23:59:59.999Z', language: 'Rust'})?.[0].change, 0);
});

test('period windows respect limit, partial starts, invalid input and month compatibility', () => {
  const repositories = [repo('owner/one', [snap('2026-01-01T00:00:00Z', 5), snap('2026-02-01T00:00:00Z', 10)])];
  const options = {since: '2026-01-15T12:00:00Z', until: '2026-02-15T12:00:00Z'};
  assert.deepEqual(insights.periodChanges?.(repositories, {...options, period: 'month'}), insights.monthlyChanges(repositories, options));
  const months = insights.periodChanges?.(repositories, {...options, period: 'month'});
  assert.equal(months?.[0].month, '2026-01');
  assert.equal(months?.[0].partial, true);
  assert.equal(months?.[0].key, '2026-01');
  const days = insights.periodChanges?.(repositories, {...options, period: 'day', limit: 2});
  assert.deepEqual(days?.map(row => row.key), ['2026-02-14', '2026-02-15']);
  assert.deepEqual(insights.periodChanges?.([], options), []);
  assert.deepEqual(insights.periodChanges?.(repositories, {...options, until: 'bad'}), []);
  assert.deepEqual(insights.periodChanges?.(repositories, {...options, limit: 0}), []);
  assert.deepEqual(insights.periodChanges?.(repositories, {...options, since: '2027-01-01'}), []);
});

test('daily, weekly and monthly deltas reconcile across repositories discovered during October', () => {
  const repos = [
    repo('owner/old', [
      snap('2026-09-30T23:59:59Z', 200),
      snap('2026-10-15T14:00:00Z', 210),
      snap('2026-10-19T20:00:00Z', 205),
    ]),
    repo('owner/new', [
      snap('2026-10-15T11:00:00Z', 10000),
      snap('2026-10-15T15:00:00Z', 10050),
      snap('2026-10-20T12:00:00Z', 10080),
      snap('2026-10-21T09:00:00Z', 10060),
    ]),
  ];
  const options = {since: '2026-10-01T00:00:00Z', until: '2026-10-23T00:00:00Z'};
  const daily = insights.periodChanges(repos, {...options, period: 'day', limit: 31});
  const weekly = insights.periodChanges(repos, {...options, period: 'week', limit: 10});
  const monthly = insights.monthlyChanges(repos, options);
  const sum = rows => rows.reduce((total, row) => total + (row.change ?? 0), 0);
  assert.equal(sum(daily), 65);
  assert.equal(sum(weekly), 65);
  assert.equal(sum(monthly), 65);
  assert.equal(monthly[0].change, 65);
  assert.deepEqual(['2026-10-15', '2026-10-19', '2026-10-20', '2026-10-21'].map(day =>
    daily.find(row => row.key === day).change), [60, -5, 30, -20]);
});

test('new repository first inventory is unknown but same-day later changes are counted', () => {
  const options = {since: '2026-10-01T00:00:00Z', until: '2026-10-23T00:00:00Z'};
  const repositories = [repo('owner/new', [
    snap('2026-10-21T10:00:00Z', 10000), snap('2026-10-21T10:05:00Z', 10010),
  ])];
  const daily = insights.periodChanges(repositories, {...options, period: 'day', limit: 31});
  const monthly = insights.monthlyChanges(repositories, options);
  assert.equal(daily.find(row => row.key === '2026-10-21').change, 10);
  assert.equal(monthly[0].change, 10);
  assert.equal(monthly[0].compared, 1);
  assert.equal(monthly[0].missing, 0);
  assert.equal(insights.monthlyChanges([repo('owner/first', [
    snap('2026-10-21T10:00:00Z', 10000),
  ])], options)[0].change, null);
});

test('display cutoff recovers exact boundary delta without duplicating carried baseline', () => {
  const repositories = [repo('owner/projected', [
    snap('2026-10-01T00:00:00Z', 115),
    snap('2026-10-01T12:00:00Z', 120),
  ])];
  repositories[0].displayBaseline = snap('2026-09-30T23:59:59Z', 100);
  const options = {since: '2026-10-01T00:00:00Z', until: '2026-10-01T23:59:59.999Z'};
  assert.equal(insights.periodChanges(repositories, {...options, period: 'day'})[0].change, 20);
  assert.equal(insights.monthlyChanges(repositories, options)[0].change, 20);
  repositories[0].history.unshift({...snap('2026-10-01T00:00:00Z', 100), displayBoundary: true});
  assert.equal(insights.monthlyChanges(repositories, options)[0].change, 20);
});

test('selected language and negative changes reconcile when first observations are later', () => {
  const before = snap('2026-10-17T00:00:00Z', 300);
  const after = snap('2026-10-19T00:00:00Z', 200);
  const repoOne = repo('owner/a', [before, after]);
  const options = {since: '2026-10-01T00:00:00Z', until: '2026-10-31T23:59:59Z', language: 'Python'};
  for (const period of ['day', 'week', 'month']) {
    const rows = insights.periodChanges([repoOne], {...options, period, limit: 40});
    assert.equal(rows.reduce((sum, row) => sum + (row.change ?? 0), 0), -100);
  }
  assert.equal(insights.monthlyChanges([repoOne], {...options, language: 'Rust'})[0].change, 0);
});
