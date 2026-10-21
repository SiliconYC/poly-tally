import test from 'node:test';
import assert from 'node:assert/strict';
import {changeGeometry, periodLabelIndices, periodDescription} from './change-chart.mjs';

test('change bars preserve a real zero baseline with honest negative, zero and unknown values', () => {
  const chart = changeGeometry([{change:20}, {change:-10}, {change:0}, {change:null}], 440);
  assert.ok(chart.zero > chart.top && chart.zero < chart.height - chart.bottom);
  const [positive, negative, zero, unknown] = chart.bars;
  assert.ok(positive.y < chart.zero); assert.equal(positive.y + positive.height, chart.zero);
  assert.equal(negative.y, chart.zero); assert.ok(negative.height > 0);
  assert.equal(zero.height, 0); assert.equal(unknown.height, 0);
  assert.equal(unknown.unknown, true);
  assert.ok(Math.abs(positive.height / negative.height - 2) < 1e-12);
  for (const value of Object.values(chart).filter(value => typeof value === 'number')) assert.ok(Number.isFinite(value));
});

test('daily label density keeps the latest bucket without collisions at narrow widths', () => {
  for (const stride of [5, 12, 20, 39, 80]) {
    const indices = periodLabelIndices(30, stride);
    assert.equal(indices.at(-1), 29);
    for (let i = 1; i < indices.length; i++) assert.ok((indices[i] - indices[i-1]) * stride >= 58);
  }
  assert.deepEqual(periodLabelIndices(0, 5), []);
});

test('period description only adds an incomplete period or missing-baseline warning when needed', () => {
  const base = {label:'2026-10', change:-10, compared:3, missing:0, partial:false, since:'2026-10-01T00:00:00Z', until:'2026-10-31T23:59:59.999Z'};
  assert.equal(periodDescription(base, '代码行').summary, '2026-10　−10 代码行');
  assert.equal(periodDescription(base, '代码行').note, '');
  const partial = periodDescription({...base, partial:true, missing:2}, '代码行');
  assert.match(partial.note, /非完整周期/); assert.match(partial.note, /2 个仓库缺少期初/);
  assert.match(periodDescription({...base, change:null}, '文件数').summary, /暂无可比数据/);
});

class ChartNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.clientWidth = 320; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent ?? '').join(' '); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  addEventListener(type, handler) { this.events[type] = handler; }
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);

test('period renderer exposes signed values and compact caveats, supports keyboard zoom and avoids overlapping daily hit regions', async t => {
  const oldDocument = globalThis.document;
  globalThis.document = {createElement:tag=>new ChartNode(tag),createElementNS:(_,tag)=>new ChartNode(tag)};
  t.after(()=>{globalThis.document=oldDocument;});
  const {renderPeriodChanges} = await import('./change-chart.mjs');
  const container = new ChartNode('div'), details = new ChartNode('div'), selected = [];
  const periods = Array.from({length:30},(_,index)=>({period:'day',key:`2026-09-${String(index+1).padStart(2,'0')}`,label:`2026-09-${String(index+1).padStart(2,'0')}`,since:`2026-09-${String(index+1).padStart(2,'0')}T00:00:00Z`,until:`2026-09-${String(index+1).padStart(2,'0')}T12:00:00Z`,change:index===0?-5:index===1?null:0,compared:index===1?0:2,missing:index===1?2:0,partial:index===29}));
  renderPeriodChanges({container,details,periods,label:'文件数',onSelect:period=>selected.push(period.key)});
  const groups=descendants(container).filter(node=>node.attributes.class==='monthly-bar');
  assert.equal(groups.length,30); assert.match(groups[0].attributes['aria-label'],/−5 文件数/);
  assert.match(groups[1].attributes['aria-label'],/暂无可比数据/);
  assert.match(details.textContent,/非完整周期/);
  for (let index=1;index<groups.length;index++) {
    const previous=groups[index-1].children[0].attributes,next=groups[index].children[0].attributes;
    assert.ok(Number(previous.x)+Number(previous.width)<=Number(next.x)+1e-8);
  }
  let prevented=false;
  groups[0].events.keydown({key:'Enter',preventDefault(){prevented=true;}});
  assert.equal(prevented,true); assert.deepEqual(selected,['2026-09-01']);
  groups[0].events.focus(); assert.match(details.textContent,/−5 文件数/); assert.doesNotMatch(details.textContent,/非完整周期/);
  renderPeriodChanges({container,details,periods:[],label:'文件数',onSelect:()=>{}});
  assert.match(container.textContent,/没有可用历史/); assert.equal(details.textContent,''); assert.equal(details.title,'','empty state must not expose a previous period to assistive technology');
});
