import test from 'node:test';
import assert from 'node:assert/strict';

import { applyReverseGeo } from '../src/geo/reverse-geo.js';

const UZ = {
  code: 'UZ',
  cities: ['Tashkent', 'Samarkand'],
  crawlCities: ['Tashkent', 'Samarkand'],
};

function withReverseAddress(address, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { address };
    },
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test('unqualified marketplace coordinates stay approximate and do not invent a road or house', async () => {
  const listing = {
    id: 'source-pin',
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.3101,
    lng: 69.2501,
    locationSource: 'coordinates',
    locationPrecision: 'coordinates',
    locationApproximate: false,
  };

  await withReverseAddress({
    road: 'Nearest Road',
    house_number: '99',
    city: 'Tashkent',
    country_code: 'uz',
  }, () => applyReverseGeo([listing], UZ, 1));

  assert.equal(listing.locationPrecision, 'broad');
  assert.equal(listing.locationApproximate, true);
  assert.equal(listing.locationAccuracyM, null);
  assert.equal(listing.address, undefined);
});

test('residential-complex centroid may infer a road but never the nearest house number', async () => {
  const listing = {
    id: 'complex-centroid',
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.3102,
    lng: 69.2502,
    locationSource: 'residentialComplex',
    locationPrecision: 'complex',
    locationApproximate: true,
  };

  await withReverseAddress({
    road: 'Sohil Street',
    house_number: '12',
    city: 'Tashkent',
    country_code: 'uz',
  }, () => applyReverseGeo([listing], UZ, 1));

  assert.equal(listing.address, 'Sohil Street');
  assert.equal(listing.addressPrecision, 'street');
  assert.equal(listing.addressApproximate, true);
  assert.doesNotMatch(listing.address, /12/u);
});

test('building-level point with unknown numeric accuracy is still eligible for admin reverse enrichment', async () => {
  const listing = {
    id: 'exact-building',
    country: 'UZ',
    city: 'Tashkent',
    address: 'Shota Rustaveli 17',
    addressSource: 'source',
    addressPrecision: 'building',
    addressApproximate: false,
    street: 'Shota Rustaveli',
    houseNumber: '17',
    lat: 41.3103,
    lng: 69.2503,
    locationSource: 'address',
    locationPrecision: 'building',
    locationApproximate: false,
    locationAccuracyM: null,
  };

  await withReverseAddress({
    road: 'Shota Rustaveli',
    house_number: '17',
    neighbourhood: 'Test Mahalla',
    city: 'Tashkent',
    country_code: 'uz',
  }, () => applyReverseGeo([listing], UZ, 1));

  assert.equal(listing.address, 'Shota Rustaveli 17');
  assert.equal(listing.addressSource, 'source');
  assert.equal(listing.microdistrict, 'Test');
  assert.equal(listing.adminSource, 'coordinates');
});

test('source coordinate that reverse-geocodes to another known city is preserved but not enriched from the conflict', async () => {
  const listing = {
    id: 'cross-city-source-pin',
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.3104,
    lng: 69.2504,
    locationSource: 'coordinates',
    locationPrecision: 'coordinates',
    locationApproximate: false,
  };

  await withReverseAddress({
    road: 'Wrong City Road',
    house_number: '5',
    neighbourhood: 'Wrong District',
    city: 'Samarkand',
    country_code: 'uz',
  }, () => applyReverseGeo([listing], UZ, 1));

  assert.equal(listing.lat, 41.3104);
  assert.equal(listing.lng, 69.2504);
  assert.equal(listing.locationValidationWarning, 'city-mismatch');
  assert.equal(listing.address, undefined);
  assert.equal(listing.microdistrict, undefined);
});
