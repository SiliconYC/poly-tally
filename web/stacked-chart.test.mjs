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
