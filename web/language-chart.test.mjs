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
