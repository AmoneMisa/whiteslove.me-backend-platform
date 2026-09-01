import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeCandidates, geocodeListings, poiDistanceM, solveSpatialPoint } from '../src/geocode.js';

const country = {
  name: 'Uzbekistan',
  cities: ['Tashkent', 'Samarkand'],
  center: { lat: 41.3111, lng: 69.2797 },
};

test('orders geocoding signals from exact to broad with street and metro above nearby POI', () => {
  const listing = {
    id: 'priority',
    city: 'Tashkent',
    district: 'Uchtepa',
    area: 'Chilanzar-12',
    nearbyShops: ['Korzinka'],
    nearby: ['Bobur Park'],
    metro: 'Chilonzor',
    street: 'Bunyodkor shoh kochasi',
    address: 'Bunyodkor shoh kochasi 10',
  };

  assert.deepEqual(
    geocodeCandidates(listing, country).map((candidate) => candidate.source),
    ['address', 'street', 'metro', 'nearby', 'nearby', 'area', 'district', 'city'],
  );
});

test('scopes an address lookup with its district', () => {
  const [candidate] = geocodeCandidates({
    city: 'Tashkent',
    district: 'Yashnabad',
    address: 'Qodisheva bozori, songgi bekat',
  }, country);

  assert.equal(candidate.source, 'address');
  assert.equal(candidate.q, 'Qodisheva bozori, songgi bekat, Yashnabad, Tashkent, Uzbekistan');
});

test('does not manufacture an apartment point from the city centroid', async () => {
  const [listing] = await geocodeListings([{ id: 'city-only', city: 'Tashkent' }], country);

  assert.equal(listing.lat, undefined);
  assert.equal(listing.lng, undefined);
  assert.equal(listing.locationSource, undefined);
});

test('caps uncached Nominatim attempts per listing', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => [] };
  };

  try {
    await geocodeListings([{
      id: `budget-${Date.now()}`,
      city: 'Tashkent',
      district: 'Yashnabad',
      microdistrict: `Missing microdistrict ${Date.now()}`,
      address: `Missing address ${Date.now()}`,
      street: `Missing street ${Date.now()}`,
      residenceComplex: `Missing complex ${Date.now()}`,
    }], { ...country, code: 'UZ' });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses expanded shared geography before district and city', () => {
  const listing = {
    id: 'expanded',
    city: 'Tashkent',
    district: 'Yakkasaray',
    microdistrict: 'Qushbegi',
    localAreas: ['Bogibaland mahalla'],
    locality: 'Yakkasaray locality',
    developmentAreas: ['New development'],
    informalAreas: ['Old town'],
    suburbs: ['Sergeli outskirts'],
    settlements: ['Nearby settlement'],
    searchClusters: ['South Tashkent'],
  };

  const sources = geocodeCandidates(listing, country).map((candidate) => candidate.source);
  assert.deepEqual(sources, [
    'microdistrict', 'localArea', 'locality', 'developmentArea', 'informalArea',
    'suburb', 'settlement', 'searchCluster', 'district', 'city',
  ]);
});

test('uses typed locationEntities as geocoding candidates and deduplicates equal queries', () => {
  const listing = {
    id: 'entities',
    city: 'Tashkent',
    district: 'Mirabad',
    microdistrict: 'Oybek',
    locationEntities: [
      { type: 'microdistrict', name: 'Oybek' },
      { type: 'mahalla', name: 'Afrosiyob', parent: 'Mirabad' },
      { type: 'street', name: 'Shahrisabz Street', parent: 'Mirabad' },
    ],
  };

  const candidates = geocodeCandidates(listing, country);
  assert.equal(candidates.filter((candidate) => candidate.source === 'microdistrict').length, 1);
  assert.ok(candidates.some((candidate) => candidate.source === 'localArea' && /Afrosiyob/.test(candidate.q)));
  assert.ok(candidates.some((candidate) => candidate.source === 'street' && /Shahrisabz Street/.test(candidate.q)));
});

test('uses area/kvartal before district and city', () => {
  const listing = {
    id: 'area',
    city: 'Tashkent',
    district: 'Yakkasaray',
    kvartal: 'Glinka',
  };

  const candidates = geocodeCandidates(listing, country);
  assert.deepEqual(candidates.map((candidate) => candidate.source), ['area', 'district', 'city']);
  assert.match(candidates[0].q, /Glinka/);
  assert.match(candidates[0].q, /Yakkasaray/);
});

test('adds an explicit city candidate instead of relying on the country center', () => {
  const listing = { id: 'samarkand', city: 'Samarkand' };
  const candidates = geocodeCandidates(listing, country);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'city');
  assert.equal(candidates[0].q, 'Samarkand, Uzbekistan');
});

test('keeps stated POI distance as geocoding uncertainty', () => {
  const listing = {
    id: 'distance',
    city: 'Tashkent',
    district: 'Yunusabad',
    nearbyShops: ['Korzinka'],
    title: 'Квартира в аренду',
    description: '500 м от Корзинки, рядом с парком',
  };

  assert.equal(poiDistanceM(listing, 'Korzinka'), 500);
  const nearby = geocodeCandidates(listing, country).find((candidate) => candidate.source === 'nearby');
  assert.equal(nearby.accuracyM, 500);
});

test('converts kilometre POI distance to metres', () => {
  const listing = { description: 'Korzinka 1.2 km' };
  assert.equal(poiDistanceM(listing, 'Korzinka'), 1200);
});

test('detects inflected Korzinka text and scopes the POI by area and district', () => {
  const listing = {
    city: 'Tashkent',
    district: 'Uchtepa',
    area: '1 kvartal',
    description: 'Учтепинский район, Квартал 1, от корзинки 500м',
  };
  const nearby = geocodeCandidates(listing, country).find((candidate) => candidate.source === 'nearby');

  assert.ok(nearby);
  assert.equal(nearby.name, 'Korzinka');
  assert.equal(nearby.distanceM, 500);
  assert.equal(nearby.q, 'Korzinka, 1 kvartal, Uchtepa, Tashkent, Uzbekistan');
});

test('solves two POI circles and uses the geographic prior to choose the intended intersection', () => {
  const anchors = [
    { lat: 41.3000, lng: 69.2000, distanceM: 500 },
    { lat: 41.3000, lng: 69.2096, distanceM: 500 },
  ];
  const prior = { lat: 41.3030, lng: 69.2048 };
  const solved = solveSpatialPoint(anchors, prior);

  assert.ok(solved);
  assert.equal(solved.anchorCount, 2);
  assert.ok(solved.lat > 41.3000);
  assert.ok(solved.residualM < 5);
});

test('keeps a finite best-effort point for inconsistent POI distances', () => {
  const solved = solveSpatialPoint([
    { lat: 41.3000, lng: 69.2000, distanceM: 100 },
    { lat: 41.3000, lng: 69.2100, distanceM: 100 },
  ]);

  assert.ok(solved);
  assert.ok(Number.isFinite(solved.lat));
  assert.ok(Number.isFinite(solved.lng));
  assert.ok(solved.residualM > 0);
});
