import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateListing, indexPlaces, nearestOfKind } from '../src/geo/nearby-places.js';

test('nearestOfKind returns all in-radius POIs by default', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    kind: 'school',
    name: `School ${index + 1}`,
    lat: 41.3 + index * 0.0001,
    lng: 69.2,
  }));
  const index = indexPlaces(rows);
  assert.equal(nearestOfKind({ lat: 41.3, lng: 69.2 }, index, 'school').length, 5);
});

test('annotateListing excludes transport rows from POI arrays', () => {
  const index = indexPlaces([
    { kind: 'transport', name: 'Bus stop', lat: 41.3, lng: 69.2 },
    { kind: 'market', name: 'Market', lat: 41.3, lng: 69.2 },
  ]);
  const listing = { lat: 41.3, lng: 69.2 };
  annotateListing(listing, index);

  assert.deepEqual(listing.nearbyPoi.map((item) => item.name), ['Market']);
  assert.equal(listing.nearbyPoiByKind.transport, undefined);
});
