import test from 'node:test';
import assert from 'node:assert/strict';
import * as utils from './chart-utils.mjs';

test('chart maximum handles large histories without expanding them into function arguments', () => {
  const points = Array.from({length: 150000}, (_, index) => ({value: index}));
  assert.equal(utils.maximumStock?.(points), 149999);
  assert.equal(utils.maximumStock?.([{value: 0}]), 1);
  assert.equal(utils.maximumStock?.([]), 1);
});
