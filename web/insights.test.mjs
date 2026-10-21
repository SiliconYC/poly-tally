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
