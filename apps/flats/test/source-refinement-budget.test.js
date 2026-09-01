import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/geocode-persistent.js', import.meta.url), 'utf8');

test('source pin refinement reuses the persistent exact lookup budget', () => {
  assert.match(source, /refineSourceCoordinateFromExactAddress\(listing, country, candidates, budget\)/);
  assert.match(source, /PERSISTENT_EXACT_GEOCODE_BUDGET/);
});
