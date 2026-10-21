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
  const methodology = html.slice(html.indexOf('class="technical-details"'));
  assert.match(methodology, /首次观测前/);
  assert.match(methodology, /只比较有期初快照的仓库/);
  assert.match(methodology, /首次观测的存量不计入净变化/);
  assert.match(html, /class="skip-link" href="#main"/);
});

test('one compact header replaces the second promotional heading', () => {
  assert.equal([...html.matchAll(/<header\b/g)].length, 1);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
  assert.match(header, /<h1\b/);
  assert.match(header, /id="updated-at"/);
  assert.match(header, /id="refresh"/);
  assert.doesNotMatch(html, /page-heading|brand-caption|eyebrow|看见代码的积累|每一个仓库，同一条时间线/);
});

test('standalone metric cards precede the trend panel', () => {
  const metrics = html.indexOf('class="metrics-grid"');
  const trend = html.indexOf('class="panel timeline-panel"');
  assert.ok(metrics > 0 && metrics < trend);
  assert.ok(html.indexOf('</section>', metrics) < trend, 'metric cards are not nested in the trend panel');
  assert.ok(trend < html.indexOf('id="chart"'));
});

test('default dashboard omits tutorial captions while preserving accessible context', () => {
  const dashboard = html.slice(html.indexOf('id="dashboard"'), html.indexOf('class="technical-details"'));
  assert.doesNotMatch(dashboard, /class="chart-instructions"|class="table-note"|悬停联动明细|展开控制显隐/);
  assert.match(html, /class="metric-context sr-only"/);
  assert.match(html, /id="chart-interaction-help" class="sr-only"/);
  assert.match(html, /id="chart"[^>]*aria-describedby="chart-interaction-help"/);
});

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
test('metric cards keep distinct surfaces without decorative animation', () => {
  assert.match(css, /\.metrics-grid\{[^}]*gap:(?!0[;px])[^;]+;/);
  assert.match(css, /\.metric-card\{[^}]*background:var\(--surface\)/);
  assert.match(css, /\.metric-card\{[^}]*border:1px solid var\(--line\)/);
  assert.doesNotMatch(css, /\.stack-layer\{[^}]*transition:|\.monthly-bar\{[^}]*transition:|\.pie-sector\{[^}]*transition:/);
});
