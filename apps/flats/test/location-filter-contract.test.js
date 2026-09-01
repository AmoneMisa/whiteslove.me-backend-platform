import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/postgres-search-core.js', import.meta.url), 'utf8');

test('postgres search contains dedicated structured location filters', () => {
  assert.match(source, /filters\.microdistrict/);
  assert.match(source, /filters\.quartal/);
  assert.match(source, /filters\.area/);
  assert.match(source, /FROM listing_location_terms term/);
  assert.match(source, /FROM listing_nearby_places place/);
});
