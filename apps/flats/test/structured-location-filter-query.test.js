import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/postgres-search-core.js', import.meta.url), 'utf8');

test('map location filters do not depend on the full-text query branch', () => {
  const microdistrict = source.indexOf('if (filters.microdistrict)');
  const fullText = source.indexOf('if (filters.query && !elasticsearchAuthoritative)');
  assert.ok(microdistrict >= 0 && fullText > microdistrict);
});
