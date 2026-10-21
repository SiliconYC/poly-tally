import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.mjs', import.meta.url), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);

test('redesigned markup preserves unique application DOM hooks', () => {
  assert.equal(ids.length, new Set(ids).size, 'duplicate ids break chart and filter bindings');
  for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(ids.includes(id), `missing app element #${id}`);
  }
});

test('all metric and sorting controls survive the compact layout', () => {
  const metrics = ['total', 'code', 'comment', 'documentation', 'blank', 'files'];
  assert.deepEqual([...html.matchAll(/data-card="([^"]+)"/g)].map(match => match[1]).sort(), [...metrics].sort());
  assert.deepEqual([...html.matchAll(/data-sort="([^"]+)"/g)].map(match => match[1]).sort(), ['name', ...metrics].sort());
  for (const id of ['repository-search', 'repository-sort', 'select-all', 'select-none', 'scope', 'language', 'metric', 'period', 'include-stale', 'current-view', 'archive-view', 'export-csv', 'table-search', 'language-sort', 'language-reset']) {
    assert.ok(ids.includes(id), `missing control ${id}`);
  }
});

test('progressive disclosure retains chart controls and statistical caveats', () => {
  assert.match(html, /<details class="legend-details">[\s\S]*?<summary>仓库图层[\s\S]*?id="chart-legend"[\s\S]*?<\/details>/);
  assert.match(html, /首次观测前未知/);
  assert.match(html, /只比较有期初快照的仓库/);
  assert.match(html, /首次观测的存量不计入净变化/);
  assert.match(html, /class="skip-link" href="#main"/);
  assert.ok(html.indexOf('id="stat-total"') < html.indexOf('class="metrics-grid"'), 'primary metric precedes the secondary strip');
});
