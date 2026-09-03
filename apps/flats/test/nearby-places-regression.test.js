import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateListing,
  annotateTransportFallback,
  indexPlaces,
  nearestOfKind,
} from '../src/geo/nearby-places.js';

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

test('annotateListing excludes bus/rail stop rows from generic POI arrays', () => {
  const index = indexPlaces([
    { kind: 'busStop', name: 'Bus stop', lat: 41.3, lng: 69.2 },
    { kind: 'railStation', name: 'Central station', lat: 41.3, lng: 69.2 },
    { kind: 'market', name: 'Market', lat: 41.3, lng: 69.2 },
  ]);
  const listing = { lat: 41.3, lng: 69.2 };
  annotateListing(listing, index);

  assert.deepEqual(listing.nearbyPoi.map((item) => item.name), ['Market']);
  assert.equal(listing.nearbyPoiByKind.busStop, undefined);
  assert.equal(listing.nearbyPoiByKind.railStation, undefined);
});

test('annotateTransportFallback fills nearbyTransport from Overpass bus/rail stops', () => {
  const index = indexPlaces([
    { kind: 'busStop', name: 'Amir Temur', lat: 41.3005, lng: 69.2, source: 'overpass', externalId: 'node/1' },
    { kind: 'railStation', name: 'Tashkent Vokzal', lat: 41.301, lng: 69.2, source: 'overpass', externalId: 'way/2' },
  ]);
  const listing = { lat: 41.3, lng: 69.2 };
  const changed = annotateTransportFallback(listing, index);

  assert.equal(changed, true);
  assert.equal(listing.transportSource, 'overpass');
  assert.deepEqual(
    listing.nearbyTransport.map(({ name, mode, osm }) => ({ name, mode, osm })),
    [
      { name: 'Amir Temur', mode: 'bus', osm: { type: 'node', id: 1 } },
      { name: 'Tashkent Vokzal', mode: 'rail', osm: { type: 'way', id: 2 } },
    ],
  );
});

test('annotateTransportFallback does not overwrite an already-annotated listing', () => {
  const index = indexPlaces([
    { kind: 'busStop', name: 'Amir Temur', lat: 41.3005, lng: 69.2 },
  ]);
  const existing = [{ id: 'geo-catalog:1', name: 'Curated stop', mode: 'bus', distanceM: 50, routeRefs: [] }];
  const listing = { lat: 41.3, lng: 69.2, nearbyTransport: existing };
  const changed = annotateTransportFallback(listing, index);

  assert.equal(changed, false);
  assert.strictEqual(listing.nearbyTransport, existing);
});
