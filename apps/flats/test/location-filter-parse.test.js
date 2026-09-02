import test from 'node:test';
import assert from 'node:assert/strict';
import { parseListingFilters } from '../src/routes/listing-routes.js';

test('structured map locations stay separate from full-text query', () => {
  const filters = parseListingFilters({
    microdistrict: 'Yunusabad-4',
    quartal: 'Darhan',
    area: 'Tashkent City',
    query: '',
  });

  assert.equal(filters.microdistrict, 'Yunusabad-4');
  assert.equal(filters.quartal, 'Darhan');
  assert.equal(filters.area, 'Tashkent City');
  assert.equal(filters.query, '');
});
