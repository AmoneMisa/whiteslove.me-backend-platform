import test from 'node:test';
import assert from 'node:assert/strict';

import { makeListing } from '../src/listing/normalize.js';
import {
  structuredAddressCacheKey,
  structuredAddressSearchParams,
} from '../src/geo/nominatim-structured.js';
import { __geocodePersistentTest } from '../src/geo/geocode-persistent.js';
import { __geocodeFacadeTest } from '../src/geo/geocode.js';

test('unqualified source coordinates stay broad and approximate', () => {
  const listing = makeListing({
    id: 'source-point',
    source: 'olx',
    country: 'UZ',
    title: 'Квартира в Ташкенте',
    description: '',
    city: 'Tashkent',
    lat: 41.31,
    lng: 69.24,
  });

  assert.equal(listing.locationSource, 'sourceCoordinates');
  assert.equal(listing.locationProvider, 'olx');
  assert.equal(listing.locationPrecision, 'broad');
  assert.equal(listing.locationApproximate, true);
  assert.equal(listing.locationAccuracyM, null);
});

test('missing coordinates are not mislabeled as a source point', () => {
  const listing = makeListing({
    id: 'no-source-point',
    source: 'olx',
    country: 'UZ',
    title: 'Квартира без координат',
    description: '',
    city: 'Tashkent',
    lat: null,
    lng: null,
  });

  assert.equal(listing.lat, null);
  assert.equal(listing.lng, null);
  assert.equal(listing.locationSource, null);
  assert.equal(listing.locationProvider, null);
  assert.equal(listing.locationPrecision, null);
  assert.equal(listing.locationApproximate, null);
});

test('explicit upstream coordinate precision is preserved', () => {
  const listing = makeListing({
    id: 'surveyed-point',
    source: 'custom',
    country: 'UZ',
    title: 'Exact property point',
    description: '',
    city: 'Tashkent',
    lat: 41.31,
    lng: 69.24,
    locationSource: 'sourceAddress',
    locationProvider: 'partner-feed',
    locationPrecision: 'building',
    locationAccuracyM: 15,
    locationApproximate: false,
  });

  assert.equal(listing.locationSource, 'sourceAddress');
  assert.equal(listing.locationProvider, 'partner-feed');
  assert.equal(listing.locationPrecision, 'building');
  assert.equal(listing.locationAccuracyM, 15);
  assert.equal(listing.locationApproximate, false);
});

test('structured exact-address lookup separates city/country from street+house', () => {
  const params = structuredAddressSearchParams({
    street: 'Muqimiy kochasi',
    houseNumber: '12A',
    city: 'Tashkent',
    countryCode: 'UZ',
  });

  assert.ok(params);
  assert.equal(params.get('q'), null);
  assert.equal(params.get('street'), '12A Muqimiy kochasi');
  assert.equal(params.get('city'), 'Tashkent');
  assert.equal(params.get('countrycodes'), 'uz');
  assert.equal(params.get('addressdetails'), '1');
});

test('structured cache identity changes with the concrete house', () => {
  const base = {
    street: 'Muqimiy kochasi',
    city: 'Tashkent',
    countryCode: 'UZ',
  };
  assert.notEqual(
    structuredAddressCacheKey({ ...base, houseNumber: '12' }),
    structuredAddressCacheKey({ ...base, houseNumber: '14' }),
  );
});

test('precision ranking follows the audit hierarchy for point-like evidence', () => {
  const { precisionRank, isStrongerPlacement } = __geocodePersistentTest;
  assert.ok(precisionRank('building') < precisionRank('complex'));
  assert.ok(precisionRank('complex') < precisionRank('reference'));
  assert.ok(precisionRank('reference') < precisionRank('station'));
  assert.ok(precisionRank('station') < precisionRank('street'));
  assert.ok(precisionRank('street') < precisionRank('broad'));

  assert.equal(
    isStrongerPlacement(
      { lat: 41.3, lng: 69.2, locationPrecision: 'station' },
      { lat: 41.31, lng: 69.21, locationPrecision: 'broad', locationApproximate: true },
    ),
    true,
  );
  assert.equal(
    isStrongerPlacement(
      { lat: 41.3, lng: 69.2, locationPrecision: 'street' },
      { lat: 41.31, lng: 69.21, locationPrecision: 'building', locationApproximate: false },
    ),
    false,
  );
});

test('direct geocoder orders exact evidence before any broad fallback', () => {
  const candidates = __geocodeFacadeTest.exactCandidates({
    city: 'Tashkent',
    district: 'Chilanzar',
    address: 'Muqimiy kochasi 12',
    street: 'Muqimiy kochasi',
    houseNumber: '12',
    residenceComplex: 'Assalom Sohil',
    metro: 'Novza',
    nearby: [],
    nearbyShops: [],
    locationEntities: [
      { type: 'poi', name: 'Korzinka', role: 'primary' },
    ],
  }, {
    code: 'UZ',
    name: 'Uzbekistan',
    cities: ['Tashkent'],
  });

  const sourceOrder = [...new Set(candidates.map((candidate) => candidate.source))];
  assert.deepEqual(sourceOrder, [
    'address',
    'residentialComplex',
    'poi',
    'metro',
    'street',
  ]);
});
