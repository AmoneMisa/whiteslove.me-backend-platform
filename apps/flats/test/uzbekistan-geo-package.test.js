import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGeoCatalogBroadAnchor,
  applyGeoCatalogCityFallback,
  applyGeoCatalogExactAnchor,
  canonicalGeoCatalogCity,
} from '../src/geo-catalog.js';
import { applyReverseGeo } from '../src/reverse-geo.js';

test('geo package adapter preserves unknown values and existing coordinates', () => {
  assert.equal(canonicalGeoCatalogCity('UZ', ' Exampleville '), 'Exampleville');

  const listing = {
    city: 'Exampleville',
    metro: 'Example Station',
    district: 'Example District',
    lat: 41.3,
    lng: 69.2,
  };

  assert.equal(applyGeoCatalogExactAnchor(listing, { code: 'UZ' }), false);
  assert.equal(applyGeoCatalogBroadAnchor(listing, { code: 'UZ' }), false);
  assert.equal(applyGeoCatalogCityFallback(listing, { code: 'UZ' }), false);
  assert.equal(listing.lat, 41.3);
  assert.equal(listing.lng, 69.2);
});

test('reverse-geocoding does not invent forward coordinates', async () => {
  const listing = { id: 'no-forward-geocode', city: 'Exampleville', lat: null, lng: null };

  const filled = await applyReverseGeo([listing], { code: 'UZ' }, 0);

  assert.equal(filled, 0);
  assert.equal(listing.lat, null);
  assert.equal(listing.lng, null);
});
