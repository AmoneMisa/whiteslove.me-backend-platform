import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeCandidates } from '../src/geo/geocode.js';
import { applyGeoCatalogBroadAnchor } from '../src/geo/geo-catalog.js';

const uzbekistan = {
  code: 'UZ',
  name: 'Uzbekistan',
  cities: ['Tashkent'],
  center: { lat: 41.3111, lng: 69.2797 },
};

test('same-name broad candidates never shadow a declared residential complex', () => {
  const listing = {
    id: 'same-name-rc-area',
    city: 'Tashkent',
    district: 'Sergeli',
    residenceComplex: 'Yangi Sergeli',
    area: 'Yangi Sergeli',
    localAreas: ['Yangi Sergeli'],
    locationEntities: [
      { type: 'residential_complex', name: 'Yangi Sergeli', role: 'primary' },
      { type: 'local_area', name: 'Yangi Sergeli', role: 'primary' },
    ],
  };

  const candidates = geocodeCandidates(listing, uzbekistan);

  assert.ok(candidates.some((candidate) =>
    candidate.source === 'residentialComplex' && candidate.name === 'Yangi Sergeli'));
  assert.equal(candidates.some((candidate) =>
    ['area', 'localArea', 'microdistrict', 'district'].includes(candidate.source)
      && candidate.name === 'Yangi Sergeli'), false);
});

test('geo-catalog broad fallback refuses the local-area owner when it matches residenceComplex', () => {
  const listing = {
    city: 'Tashkent',
    district: 'Sergeli',
    residenceComplex: 'Yangi Sergeli',
    area: 'Yangi Sergeli',
  };

  assert.equal(applyGeoCatalogBroadAnchor(listing, uzbekistan), false);
  assert.equal(listing.lat, undefined);
  assert.equal(listing.lng, undefined);
  assert.equal(listing.locationGeoEntityId, undefined);
});

test('geo-catalog broad fallback still accepts an unrelated valid area', () => {
  const listing = {
    city: 'Tashkent',
    district: 'Sergeli',
    residenceComplex: 'Missing Residential Complex',
    area: 'Yangi Sergeli',
  };

  assert.equal(applyGeoCatalogBroadAnchor(listing, uzbekistan), true);
  assert.equal(listing.locationGeoEntityId, 'uz:tashkent:local-area:yangi-sergeli');
  assert.equal(listing.locationCanonical, 'Yangi Sergeli');
});
