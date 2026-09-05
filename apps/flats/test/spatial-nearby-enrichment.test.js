import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateListing, indexPlaces } from '../src/geo/nearby-places.js';
import {
  annotateMetroWalkingWithCatalog,
  annotateNearbyTransportWithCatalog,
} from '../src/geo/transport-nearby.js';

test('nearby POI storage keeps every in-radius place while legacy views stay bounded', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    kind: 'pharmacy',
    name: `Pharmacy ${index + 1}`,
    nameRu: null,
    lat: 41.3000 + index * 0.0002,
    lng: 69.2000,
    source: 'overpass',
    externalId: `node/${index + 1}`,
  }));
  const listing = { lat: 41.3000, lng: 69.2000 };

  const changed = annotateListing(listing, indexPlaces(rows));

  assert.equal(changed, true);
  assert.equal(listing.nearbyPoi.length, 6);
  assert.equal(listing.nearbyPoiByKind.pharmacy.length, 6);
  assert.equal(listing.nearbyByKind.pharmacy.length, 3);
  assert.equal(listing.nearbyPlaces.length, 6);
  assert.ok(listing.nearbyPoi.every((item, index) => index === 0 || item.distanceM >= listing.nearbyPoi[index - 1].distanceM));
});

test('transport enrichment stores all nearby metro and non-metro stops with route refs', () => {
  const listing = {
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.31,
    lng: 69.28,
    locationAccuracyM: 25,
  };

  const fakeCatalog = {
    nearestTransportStops(_point, options) {
      if (options.mode === 'metro') {
        return [
          { stop: { id: 'm1', canonicalName: 'Metro A', mode: 'metro', source: 'osm' }, distanceM: 300, routeRefs: ['red'] },
          { stop: { id: 'm2', canonicalName: 'Metro B', mode: 'metro', source: 'osm' }, distanceM: 900, routeRefs: ['blue'] },
        ];
      }
      return [
        { stop: { id: 'm1', canonicalName: 'Metro A', mode: 'metro', source: 'osm' }, distanceM: 300, routeRefs: ['red'] },
        { stop: { id: 'b1', canonicalName: 'Bus Stop A', mode: 'bus', source: 'osm', osm: { type: 'node', id: 1 } }, distanceM: 120, routeRefs: ['5', '17'] },
        { stop: { id: 'b2', canonicalName: 'Bus Stop B', mode: 'bus', source: 'osm' }, distanceM: 480, routeRefs: ['22'] },
      ];
    },
  };

  const count = annotateNearbyTransportWithCatalog([listing], { code: 'UZ', cities: ['Tashkent'] }, fakeCatalog);

  assert.equal(count, 1);
  assert.deepEqual(listing.nearbyMetro.map((item) => item.name), ['Metro A', 'Metro B']);
  assert.deepEqual(listing.nearbyTransport.map((item) => item.name), ['Bus Stop A', 'Bus Stop B']);
  assert.deepEqual(listing.nearbyTransport[0].routeRefs, ['5', '17']);
  assert.equal(listing.metro, 'Metro A');
  assert.equal(listing.metroDistanceM, 300);
  assert.equal(listing.transportSource, 'geo-catalog');
});

test('metro walking enrichment stores pedestrian distance/time and picks the walking-nearest coordinate metro', async () => {
  const listing = {
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.31,
    lng: 69.28,
    locationAccuracyM: 25,
    metro: 'Metro A',
    metroSource: 'coordinates',
    metroDistanceM: 300,
    nearbyMetro: [
      { id: 'm1', name: 'Metro A', mode: 'metro', distanceM: 300, routeRefs: ['red'] },
      { id: 'm2', name: 'Metro B', mode: 'metro', distanceM: 900, routeRefs: ['blue'] },
    ],
  };

  const fakeCatalog = {
    nearestTransportStops(_point, options) {
      assert.equal(options.mode, 'metro');
      assert.equal(options.limit, 3);
      return [
        {
          stop: {
            id: 'm1',
            canonicalName: 'Metro A',
            mode: 'metro',
            center: { lat: 41.312, lng: 69.282 },
          },
          distanceM: 300,
          routeRefs: ['red'],
        },
        {
          stop: {
            id: 'm2',
            canonicalName: 'Metro B',
            mode: 'metro',
            center: { lat: 41.318, lng: 69.288 },
          },
          distanceM: 900,
          routeRefs: ['blue'],
        },
      ];
    },
  };

  const count = await annotateMetroWalkingWithCatalog(
    [listing],
    { code: 'UZ', cities: ['Tashkent'] },
    fakeCatalog,
    async (_origin, targets) => {
      assert.deepEqual(targets, [
        { lat: 41.312, lng: 69.282 },
        { lat: 41.318, lng: 69.288 },
      ]);
      return [
        { distanceM: 1120, durationMin: 15 },
        { distanceM: 980, durationMin: 13 },
      ];
    },
  );

  assert.equal(count, 1);
  assert.equal(listing.nearbyMetro[0].walkingDistanceM, 1120);
  assert.equal(listing.nearbyMetro[0].walkingDurationMin, 15);
  assert.equal(listing.nearbyMetro[1].walkingDistanceM, 980);
  assert.equal(listing.nearbyMetro[1].walkingDurationMin, 13);
  assert.equal(listing.metro, 'Metro B');
  assert.equal(listing.metroDistanceM, 900);
  assert.equal(listing.metroWalkingDistanceM, 980);
  assert.equal(listing.metroWalkingDurationMin, 13);
  assert.equal(listing.walkingRouteSource, 'valhalla');
});

test('transport enrichment accepts legacy source coordinates without accuracy metadata', () => {
  const listing = {
    country: 'UZ',
    city: 'Tashkent',
    lat: 41.31,
    lng: 69.28,
  };

  const fakeCatalog = {
    nearestTransportStops(_point, options) {
      if (options.mode === 'metro') {
        return [
          { stop: { id: 'm1', canonicalName: 'Metro A', mode: 'metro', source: 'osm' }, distanceM: 640, routeRefs: ['red'] },
        ];
      }
      return [
        { stop: { id: 'b1', canonicalName: 'Bus Stop A', mode: 'bus', source: 'osm' }, distanceM: 260, routeRefs: ['17'] },
      ];
    },
  };

  const count = annotateNearbyTransportWithCatalog([listing], { code: 'UZ', cities: ['Tashkent'] }, fakeCatalog);

  assert.equal(count, 1);
  assert.deepEqual(listing.nearbyMetro.map((item) => item.name), ['Metro A']);
  assert.deepEqual(listing.nearbyTransport.map((item) => item.name), ['Bus Stop A']);
  assert.equal(listing.transportSource, 'geo-catalog');
});

test('transport enrichment does not infer nearby stops from coarse coordinates', () => {
  const listing = { country: 'UZ', city: 'Tashkent', lat: 41.31, lng: 69.28, locationAccuracyM: 2500 };
  const fakeCatalog = { nearestTransportStops: () => { throw new Error('should not run'); } };

  assert.equal(annotateNearbyTransportWithCatalog([listing], { code: 'UZ' }, fakeCatalog), 0);
  assert.equal(listing.nearbyTransport, undefined);
});
