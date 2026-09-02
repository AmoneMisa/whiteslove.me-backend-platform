import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateInsideBbox } from '../src/geo/coordinate-validation.js';

test('coordinate bbox validation still accepts valid city points', () => {
  assert.equal(coordinateInsideBbox(41.31, 69.24, [41.1, 69.0, 41.5, 69.5], 0), true);
  assert.equal(coordinateInsideBbox(40.9, 69.24, [41.1, 69.0, 41.5, 69.5], 0), false);
});
