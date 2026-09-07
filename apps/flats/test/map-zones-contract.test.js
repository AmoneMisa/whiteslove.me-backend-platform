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
  assert.ok(Array.isArray(zones.schools));
  assert.ok(Array.isArray(zones.residentialComplexes));
  assert.ok(Array.isArray(zones.airports));
  assert.ok(Array.isArray(zones.railwayStations));
  assert.ok(Array.isArray(zones.busStations));
  assert.ok(Array.isArray(zones.transportStops));
  assert.ok(Array.isArray(zones.parkings));
  assert.ok(zones.parks.every((zone) => zone.type === 'poi.park'));
  assert.ok(zones.shoppingMalls.every((zone) => zone.type === 'poi.shopping_mall'));
  assert.ok(zones.universities.every((zone) => zone.type === 'poi.university'));
  assert.ok(zones.schools.every((zone) => zone.type === 'poi.school'));
  assert.ok(zones.residentialComplexes.every((zone) => zone.type === 'residential_complex'));
  assert.ok(zones.airports.every((zone) => zone.type === 'poi.airport'));
  assert.ok(zones.railwayStations.every((zone) => zone.type === 'poi.railway_station'));
  assert.ok(zones.busStations.every((zone) => zone.type === 'poi.bus_station'));
  assert.ok(zones.transportStops.every((zone) => zone.type === 'transport_stop'));
});

test('empty map-zone request keeps the complete stable map contract', () => {
  assert.deepEqual(mapZonesFor('', ''), {
    districtZones: [],
    microdistrictMarkers: [],
    quartalMarkers: [],
    areaZones: [],
    metroStations: [],
    parks: [],
    shoppingMalls: [],
    universities: [],
    schools: [],
    residentialComplexes: [],
    airports: [],
    railwayStations: [],
    busStations: [],
    transportStops: [],
    parkings: [],
    cityZone: null,
  });
});
