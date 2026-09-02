import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseListingFilters} from '../src/routes/listing-routes.js';

test('listing feed defaults to 20 rows without shrinking the public max', () => {
  assert.equal(parseListingFilters({}).limit, 20);
  assert.equal(parseListingFilters({limit: '1'}).limit, 1);
  assert.equal(parseListingFilters({limit: '20'}).limit, 20);
  assert.equal(parseListingFilters({limit: '50'}).limit, 50);
  assert.equal(parseListingFilters({limit: '999'}).limit, 60);
});

test('listing feed does not do per-row nearby transport enrichment', async () => {
  const source = await readFile(new URL('../src/routes/listing-routes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /annotateNearbyTransport/);
});
