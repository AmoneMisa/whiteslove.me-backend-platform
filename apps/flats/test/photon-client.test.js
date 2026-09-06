import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectPhotonPoint,
  supportsPhotonExpectation,
} from '../src/geo/photon-client.js';

function feature({
  name = 'Yangi Sergeli',
  city = 'Tashkent',
  countrycode = 'UZ',
  osm_key = 'building',
  osm_value = 'apartments',
  coordinates = [69.225708, 41.221894],
  extent = [69.2249, 41.2212, 69.2265, 41.2225],
} = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      name,
      city,
      countrycode,
      osm_key,
      osm_value,
      osm_type: 'W',
      osm_id: 12345,
      extent,
    },
  };
}

const complexExpectation = {
  kind: 'entity',
  name: 'Yangi Sergeli',
  city: 'Tashkent',
  level: 'complex',
};

test('Photon accepts a typed same-city residential-sized entity', () => {
  const point = selectPhotonPoint({ features: [feature()] }, complexExpectation, 'UZ');

  assert.ok(point);
  assert.equal(point.lat, 41.221894);
  assert.equal(point.lng, 69.225708);
  assert.equal(point.precision, 'complex');
  assert.equal(point.provider, 'photon');
  assert.equal(point.providerId, 'W:12345');
  assert.equal(point.providerType, 'building:apartments');
});

test('Photon rejects a same-name broad area for a residential-complex lookup', () => {
  const point = selectPhotonPoint({
    features: [feature({ osm_key: 'place', osm_value: 'neighbourhood' })],
  }, complexExpectation, 'UZ');

  assert.equal(point, null);
});

test('Photon rejects wrong city and wrong country even when the name matches', () => {
  assert.equal(selectPhotonPoint({
    features: [feature({ city: 'Samarkand' })],
  }, complexExpectation, 'UZ'), null);

  assert.equal(selectPhotonPoint({
    features: [feature({ countrycode: 'KZ' })],
  }, complexExpectation, 'UZ'), null);
});

test('Photon is not trusted for exact building addresses', () => {
  assert.equal(supportsPhotonExpectation({
    kind: 'address',
    street: 'Shota Rustaveli',
    houseNumber: '12',
    city: 'Tashkent',
    level: 'building',
  }), false);
});
