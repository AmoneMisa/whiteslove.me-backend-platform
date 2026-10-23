import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateInsideBbox, orientCoordinates } from '../src/geo/coordinate-validation.js';

test('coordinate bbox validation still accepts valid city points', () => {
  assert.equal(coordinateInsideBbox(41.31, 69.24, [41.1, 69.0, 41.5, 69.5], 0), true);
  assert.equal(coordinateInsideBbox(40.9, 69.24, [41.1, 69.0, 41.5, 69.5], 0), false);
});

test('orientCoordinates swaps a lat/lng pair that only fits the area the other way round', () => {
  const kyiv = [50.2, 30.2, 50.7, 30.9];
  assert.deepEqual(orientCoordinates(30.59, 50.43, kyiv, 0), { lat: 50.43, lng: 30.59, swapped: true });
  assert.deepEqual(orientCoordinates(50.43, 30.59, kyiv, 0), { lat: 50.43, lng: 30.59, swapped: false });
  assert.deepEqual(orientCoordinates(10, 10, kyiv, 0), { lat: 10, lng: 10, swapped: false });
  assert.equal(orientCoordinates(30.59, 50.43, null).swapped, false);
});
