import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/postgres-search-fast-core.js', import.meta.url), 'utf8');

test('structured location filters bypass unfiltered fast feed path', () => {
  assert.match(source, /filters\.microdistrict/);
  assert.match(source, /filters\.quartal/);
  assert.match(source, /filters\.area/);
});
