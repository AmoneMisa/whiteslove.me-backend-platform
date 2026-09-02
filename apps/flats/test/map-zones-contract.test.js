import test from 'node:test';
import assert from 'node:assert/strict';

import {mapZonesFor} from '../src/geo/district-zones.js';

test('map zones expose canonical city center and structured filter layers', () => {
  const zones = mapZonesFor('UZ', 'Tashkent');

  assert.equal(zones.cityZone?.name, 'Tashkent');
  assert.ok(Number.isFinite(zones.cityZone?.lat));
  assert.ok(Number.isFinite(zones.cityZone?.lng));
  assert.ok(zones.districtZones.length > 0);
  assert.ok(zones.microdistrictMarkers.every((zone) => zone.name));
  assert.ok(zones.quartalMarkers.every((zone) => zone.name));
  assert.ok(zones.metroStations.length > 0);
  assert.ok(zones.metroStations.every((zone) => zone.type === 'metro'));
  assert.ok(zones.metroStations.every((zone) => Number.isFinite(zone.lat) && Number.isFinite(zone.lng)));
  assert.ok(Array.isArray(zones.parks));
  assert.ok(Array.isArray(zones.shoppingMalls));
  assert.ok(Array.isArray(zones.universities));
  assert.ok(zones.parks.every((zone) => zone.type === 'poi.park'));
  assert.ok(zones.shoppingMalls.every((zone) => zone.type === 'poi.shopping_mall'));
  assert.ok(zones.universities.every((zone) => zone.type === 'poi.university'));
});

test('empty map-zone request keeps a stable cityZone field', () => {
  assert.deepEqual(mapZonesFor('', ''), {
    districtZones: [],
    microdistrictMarkers: [],
    quartalMarkers: [],
    areaZones: [],
    metroStations: [],
    parks: [],
    shoppingMalls: [],
    universities: [],
    cityZone: null,
  });
});
