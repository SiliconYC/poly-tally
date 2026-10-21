import test from 'node:test';
import assert from 'node:assert/strict';
import * as chart from './language-chart.mjs';

test('pie sectors conserve a full turn and retain exact values for small languages', () => {
  const result = chart.pieSlices?.([{name: 'Python', value: 75}, {name: 'JSON', value: 24}, {name: 'Lua', value: 1}]);
  assert.deepEqual(result?.map(s => [s.name, s.value, s.start, s.end]), [['Python', 75, 0, .75], ['JSON', 24, .75, .99], ['Lua', 1, .99, 1]]);
});

test('pie empty and single-language cases produce honest finite proportions', () => {
  assert.deepEqual(chart.pieSlices?.([]), []);
  assert.deepEqual(chart.pieSlices?.([{name: 'Python', value: 0}]), []);
  const result = chart.pieSlices?.([{name: 'Rust', value: 20}]);
  assert.equal(result?.[0].start, 0);
  assert.equal(result?.[0].end, 1);
});

class ChartNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.events = {}; this._text = ''; this.classList = {toggle:()=>{}}; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent ?? '').join(' '); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  addEventListener(type, handler) { this.events[type] = handler; }
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
function mount(t, options) {
  const oldDocument = globalThis.document;
  globalThis.document = {createElement:tag=>new ChartNode(tag), createElementNS:(_,tag)=>new ChartNode(tag)};
  t.after(()=>{globalThis.document=oldDocument;});
  const container = new ChartNode('div'), list = new ChartNode('div');
  chart.renderLanguageChart({container, list, label:'代码行', ...options});
  return {container,list};
}

test('repository composition copies only labelled name buttons, never an entire sector or numerical row', t => {
  const selected = [];
  const {container, list} = mount(t, {dimension:'repository', languages:[{id:'lineage:one', name:'same', fullName:'owner-a/same', value:70},{id:'standalone', name:'same', fullName:'owner-b/same', value:30}], onSelect:(name,item)=>selected.push(item.id)});
  const sectors = descendants(container).filter(node=>node.tag==='path');
  assert.equal(sectors.length,2);
  for (const sector of sectors) {
    assert.equal(sector.attributes.role,'img'); assert.equal(sector.events.click,undefined); assert.equal(sector.events.keydown,undefined);
    assert.match(sector.attributes['aria-label'],/same/); assert.match(sector.attributes['aria-label'],/代码行/);
  }
  const buttons = descendants(list).filter(node=>node.tag==='button');
  assert.equal(buttons.length,2); assert.equal(buttons[0].attributes['aria-label'],'复制完整仓库名称 owner-a/same');
  assert.equal(list.children[0].tag,'div'); assert.equal(list.children[0].events.click,undefined);
  buttons[1].events.click(); assert.deepEqual(selected,['standalone']);
  sectors[0].events.pointerenter(); assert.equal(sectors[0].style.opacity,'1'); assert.equal(sectors[1].style.opacity,'.27');
});

test('language composition retains native row activation, sector keyboard selection and honest empty states', t => {
  const selected = [];
  const {container,list} = mount(t,{languages:[{name:'Python',value:5}],onSelect:name=>selected.push(name)});
  const sector=descendants(container).find(node=>node.tag==='path');
  sector.events.keydown({key:' ',preventDefault(){}}); list.children[0].events.click();
  assert.deepEqual(selected,['Python','Python']); assert.equal(list.children[0].tag,'button');
  const empty=mount(t,{dimension:'repository',languages:[],onSelect:()=>{}});
  assert.match(empty.container.textContent,/暂无仓库数据/);
});
