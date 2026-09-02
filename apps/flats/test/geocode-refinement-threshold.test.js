import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/geo/geocode-persistent.js', import.meta.url), 'utf8');

test('source pin refinement uses a bounded exact-address discrepancy threshold', () => {
  assert.match(source, /SOURCE_COORD_EXACT_MAX_DISTANCE_M/);
  assert.match(source, /> SOURCE_COORD_EXACT_MAX_DISTANCE_M/);
});
