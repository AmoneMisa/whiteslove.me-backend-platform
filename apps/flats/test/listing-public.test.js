import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeStoredFreshListing} from '../src/routes/listing-public.js';

test('live reload preserves external fields but drops stale transport and market data', () => {
  const stored = {
    id: '42',
    source: 'olx',
    country: 'UZ',
    title: 'Old title',
    price: 500,
    vision: {derivedFields: ['parking']},
    locationSource: 'address',
    locationAccuracyM: 40,
    lat: 41.30,
    lng: 69.24,
    nearbyTransport: [{id: 'old-bus', mode: 'bus'}],
    nearbyMetro: [{id: 'old-metro', mode: 'metro'}],
    marketComparison: {goodPrice: true},
    studentTarget: true,
    transitRoutes: ['17'],
  };
  const fresh = {
    id: '42',
    source: 'olx',
    country: 'UZ',
    title: 'Fresh title',
    price: 550,
    lat: 41.31,
    lng: 69.25,
  };

  const merged = mergeStoredFreshListing(stored, fresh);

  assert.equal(merged.title, 'Fresh title');
  assert.equal(merged.price, 550);
  assert.deepEqual(merged.vision, {derivedFields: ['parking']});
  assert.equal(merged.nearbyTransport, undefined);
  assert.equal(merged.nearbyMetro, undefined);
  assert.equal(merged.marketComparison, undefined);
  assert.equal(merged.studentTarget, undefined, 'text-derived fields must be recalculated');
  assert.equal(merged.transitRoutes, undefined, 'text-derived routes must be recalculated');
  assert.equal(merged.locationSource, undefined, 'fresh coordinates invalidate old provenance');
  assert.equal(merged.locationAccuracyM, undefined);
});

test('live reload keeps validated stored coordinates when source omits a point', () => {
  const merged = mergeStoredFreshListing({
    id: '42',
    lat: 41.3,
    lng: 69.2,
    locationSource: 'address',
    locationAccuracyM: 40,
  }, {
    id: '42',
    lat: null,
    lng: null,
  });

  assert.equal(merged.lat, 41.3);
  assert.equal(merged.lng, 69.2);
  assert.equal(merged.locationSource, 'address');
  assert.equal(merged.locationAccuracyM, 40);
});

test('rejected fresh source coordinates do not resurrect the old point', () => {
  const merged = mergeStoredFreshListing({
    id: '42',
    lat: 41.3,
    lng: 69.2,
    locationSource: 'coordinates',
    locationAccuracyM: 25,
  }, {
    id: '42',
    lat: null,
    lng: null,
    sourceCoordinateRejected: true,
  });

  assert.equal(merged.lat, null);
  assert.equal(merged.lng, null);
});
