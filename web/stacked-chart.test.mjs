import test from 'node:test';
import assert from 'node:assert/strict';
import {stackLayers} from './stacked-chart.mjs';

test('stack boundaries conserve repository stock without overlapping layers', () => {
  const points = [{value: 10, values: [10, null, null]}, {value: 40, values: [16, 20, 4]}];
  assert.deepEqual(stackLayers(points, 3), [
    {lower: [0, 0], upper: [10, 16]}, {lower: [10, 16], upper: [10, 36]}, {lower: [10, 36], upper: [10, 40]},
  ]);
});

test('percentage stacks reach 100 and handle all-zero snapshots without NaN', () => {
  assert.deepEqual(stackLayers([{value: 0, values: [0, null]}, {value: 40, values: [10, 30]}], 2, true), [
    {lower: [0, 0], upper: [0, 25]}, {lower: [0, 25], upper: [0, 100]},
  ]);
});

import * as charts from './stacked-chart.mjs';
const day = n => `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`;
const hitPoints = [
  {timestamp: day(1), value: 100, values: [60, 40, null]},
  {timestamp: day(3), value: 200, values: [20, 100, 80]},
  {timestamp: day(5), value: 200, values: [20, 100, 80]},
];
const hit = (x, y, {points = hitPoints, percent = false, maximum = percent ? 100 : 200} = {}) => charts.stackedHitTest?.({points, layers: stackLayers(points, points[0]?.values.length ?? 0, percent), x, y, left: 40, top: 20, plotWidth: 400, plotHeight: 200, maximum});

test('pointer hit testing identifies the actual step band using both coordinates', () => {
  assert.deepEqual(hit(100, 180), {pointIndex: 0, seriesIndex: 0});
  assert.deepEqual(hit(100, 140), {pointIndex: 0, seriesIndex: 1});
  assert.deepEqual(hit(239, 140), {pointIndex: 0, seriesIndex: 1}, 'do not select the nearest future snapshot');
  assert.deepEqual(hit(240, 80), {pointIndex: 1, seriesIndex: 2}, 'a step changes exactly at its timestamp');
  assert.deepEqual(hit(440, 200), {pointIndex: 2, seriesIndex: 1}, 'shared boundaries consistently identify the upper layer');
});

test('pointer hit testing does not invent repositories in whitespace, zero bands or outside the plot', () => {
  assert.deepEqual(hit(100, 40), {pointIndex: 0, seriesIndex: null});
  assert.equal(hit(39, 180), null);
  assert.equal(hit(441, 180), null);
  assert.equal(hit(100, 19), null);
  assert.equal(hit(100, 221), null);
  assert.deepEqual(hit(100, 220, {points: [{timestamp: day(1), value: 0, values: [0, null]}]}), {pointIndex: 0, seriesIndex: null});
});

test('pointer hit testing honors normalized percentages and single-snapshot full-width bands', () => {
  assert.deepEqual(hit(100, 120, {percent: true}), {pointIndex: 0, seriesIndex: 0});
  assert.deepEqual(hit(100, 60, {percent: true}), {pointIndex: 0, seriesIndex: 1});
  assert.deepEqual(hit(430, 180, {points: [hitPoints[0]]}), {pointIndex: 0, seriesIndex: 0});
});

const labels = (points, {percent = false, measureText = name => name.length * 7} = {}) => charts.stackBandLabels?.({
  series: [{id: 'large', name: 'large-repo'}, {id: 'small', name: 'tiny'}, {id: 'middle', name: 'medium'}],
  points, layers: stackLayers(points, 3, percent),
  x: timestamp => 40 + (Date.parse(timestamp) - Date.parse(day(1))) / (4 * 86400000) * 400,
  y: value => 220 - value * (percent ? 2 : 1), left: 40, right: 440, measureText,
});

test('right-edge labels only occupy legible nonzero bands and fit their full text', () => {
  const points = [{timestamp: day(1), value: 200, values: [150, 3, 47]}, {timestamp: day(5), value: 200, values: [150, 3, 47]}];
  assert.deepEqual(labels(points)?.map(label => label.id), ['large', 'middle']);
  assert.deepEqual(labels(points, {measureText: () => 500}), [], 'skip labels wider than the available plot, rather than overlap');
  assert.deepEqual(labels(points, {percent: true})?.map(label => label.id), ['large', 'middle']);
});

test('right-edge labels stay inside every step beneath the text, not just the final snapshot', () => {
  const points = [{timestamp: day(1), value: 200, values: [10, 0, 190]}, {timestamp: day(5), value: 200, values: [190, 0, 10]}];
  assert.deepEqual(labels(points), [], 'a tall latest boundary does not create room across a conflicting earlier band');
});

// Minimal DOM harness executes the actual renderer and event listeners without
// introducing a browser dependency into the project's node:test suite.
class ChartNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.events = {}; this.clientWidth = 600; this.clientHeight = 300; this.offsetWidth = 230; this.hidden = false; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent ?? '').join(' '); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of [...nodes].reverse()) { node.parent = this; this.children.unshift(node); } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  querySelectorAll(tag) { return descendants(this).filter(node => node.tag === tag); }
  addEventListener(type, handler) { this.events[type] = handler; }
  dispatch(type, event = {}) { this.events[type]?.(event); }
  focus() { document.activeElement = this; }
  getBoundingClientRect() { return {left: 10, top: 20, width: 300, height: 150}; }
  getComputedTextLength() { return this.textContent.length * 6; }
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const simpleRepository = (id, values) => ({id, name: `owner/${id}`, history: values.map(([timestamp, code]) => ({timestamp, metrics: {code}, languages: {Python: {code}}}))});
function mountChart(t, repositories, options = {}) {
  const oldDocument = globalThis.document;
  globalThis.document = {activeElement: null, createElement: tag => new ChartNode(tag), createElementNS: (_, tag) => new ChartNode(tag)};
  t.after(() => { globalThis.document = oldDocument; });
  const nodes = Object.fromEntries(['container', 'navigator', 'legend', 'details', 'rangeLabel'].map(key => [key, new ChartNode('div')]));
  const view = options.view ?? {hidden: new Set(), range: null, percent: false};
  charts.renderStackedChart({...nodes, repositories, colors: new Map(repositories.map(repo => [repo.id, '#438e7c'])), metric: 'code', label: '代码行', language: 'all', until: day(5), ...options, view});
  return {...nodes, view, svg: nodes.container.children[0], tooltip: nodes.container.children[1]};
}
const pointerAt = (svgX, svgY) => ({clientX: 10 + svgX / 2, clientY: 20 + svgY / 2});

test('renderer identifies a hovered repository outside the former top five and pins that exact band', t => {
  const repositories = [100, 80, 60, 40, 20, 10].map((value, index) => simpleRepository(`repo-${index + 1}`, [[day(1), value]]));
  const {svg, tooltip} = mountChart(t, repositories);
  const tiny = pointerAt(300, 268 - 305 / 350 * 244);
  svg.dispatch('pointermove', tiny);
  assert.match(tooltip.textContent, /repo-6/);
  assert.match(tooltip.textContent, /10 代码行/);
  assert.match(tooltip.textContent, /可见合计 310/);
  assert.doesNotMatch(tooltip.textContent, /repo-1/, 'hover is focused, not a top-five list');
  svg.dispatch('click', tiny);
  svg.dispatch('pointermove', pointerAt(300, 250));
  assert.match(tooltip.textContent, /repo-6/, 'pin retains the repository as well as the timestamp');
  svg.dispatch('click', pointerAt(300, 250));
  assert.match(tooltip.textContent, /repo-1/);
});

test('renderer keeps all-history order through a narrowed period and brush, with hidden layers absent', t => {
  const repositories = [simpleRepository('burst', [[day(4), 200]]), simpleRepository('long', [[day(1), 100], [day(4), 1]]), simpleRepository('hidden', [[day(1), 999]])];
  const view = {hidden: new Set(['hidden']), range: [Date.parse(day(4)), Date.parse(day(5))], percent: false};
  const {svg, tooltip} = mountChart(t, repositories, {since: day(4), view});
  const paths = descendants(svg).filter(node => node.attributes.class === 'stack-layer');
  assert.deepEqual(paths.map(node => node.attributes['data-series']), ['long', 'burst']);
  assert.doesNotMatch(svg.textContent, /hidden/);
  svg.dispatch('pointermove', pointerAt(300, 100));
  assert.match(tooltip.textContent, /burst/);
  assert.doesNotMatch(tooltip.textContent, /hidden/);
});

test('renderer adds fitted right-edge names and clears hover outside the plot', t => {
  const repositories = [simpleRepository('large', [[day(1), 100]]), simpleRepository('thin', [[day(1), 1]])];
  const {svg, tooltip} = mountChart(t, repositories);
  const labels = descendants(svg).filter(node => node.attributes.class === 'stack-band-label');
  assert.deepEqual(labels.map(node => node.textContent), ['large']);
  assert.equal(labels[0].attributes['pointer-events'], 'none');
  svg.dispatch('pointermove', pointerAt(300, 150));
  assert.equal(tooltip.hidden, false);
  svg.dispatch('pointermove', pointerAt(20, 150));
  assert.equal(tooltip.hidden, true);
});

test('percent-mode renderer identifies the normalized band and retains absolute values as context', t => {
  const repositories = [simpleRepository('major', [[day(1), 30]]), simpleRepository('minor', [[day(1), 10]])];
  const {svg, tooltip} = mountChart(t, repositories, {view: {hidden: new Set(), range: null, percent: true}});
  svg.dispatch('pointermove', pointerAt(300, 268 - .9 * 244));
  assert.match(tooltip.textContent, /minor/);
  assert.match(tooltip.textContent, /25\.0%/);
  assert.match(tooltip.textContent, /10 代码行 · 可见合计 40 代码行/);
});

test('pinned keyboard navigation preserves repo identity, reports unknown stock, and Escape resets highlight', t => {
  const repositories = [simpleRepository('early', [[day(1), 100]]), simpleRepository('late', [[day(4), 10]])];
  const {svg, tooltip} = mountChart(t, repositories);
  svg.dispatch('click', pointerAt(580, 268 - 105 / 150 * 244));
  assert.match(tooltip.textContent, /late/);
  svg.dispatch('keydown', {key: 'Home', preventDefault() {}});
  assert.match(tooltip.textContent, /late/);
  assert.match(tooltip.textContent, /未观测/);
  svg.dispatch('keydown', {key: 'Escape', preventDefault() {}});
  assert.equal(tooltip.hidden, true);
  assert.ok(descendants(svg).filter(node => node.attributes.class === 'stack-layer').every(node => node.style.opacity === '1'));
});

test('long repository names remain complete in hover even when no in-band label fits', t => {
  const name = 'a-very-long-repository-name-that-cannot-fit-the-chart-band';
  const {svg, tooltip} = mountChart(t, [simpleRepository(name, [[day(1), 100]])], {until: day(1)});
  assert.deepEqual(descendants(svg).filter(node => node.attributes.class === 'stack-band-label'), []);
  svg.dispatch('pointermove', pointerAt(580, 150));
  assert.ok(tooltip.textContent.includes(name));
  assert.match(tooltip.textContent, /100 代码行/);
});
