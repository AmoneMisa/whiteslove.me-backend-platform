import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeCandidates } from '../src/geo/geocode.js';
import {
  nominatimCacheKey,
  selectNominatimPoint,
} from '../src/geo/nominatim-client.js';

const UZ = {
  code: 'UZ',
  name: 'Uzbekistan',
  cities: ['Tashkent'],
  center: { lat: 41.2995, lng: 69.2401 },
};

function result({
  lat = '41.30',
  lon = '69.24',
  house = null,
  road = null,
  city = 'Tashkent',
  countryCode = 'uz',
  name = null,
  type = 'house',
} = {}) {
  return {
    lat,
    lon,
    name,
    display_name: [house, road, city, 'Uzbekistan'].filter(Boolean).join(', '),
    addresstype: type,
    type,
    osm_type: 'way',
    osm_id: 123,
    address: {
      ...(house ? { house_number: house } : {}),
      ...(road ? { road } : {}),
      ...(city ? { city } : {}),
      country_code: countryCode,
    },
  };
}

test('exact address rejects a different house number instead of accepting first hit', () => {
  const point = selectNominatimPoint([
    result({ house: '71', road: 'Shota Rustaveli' }),
    result({ house: '17', road: 'Shota Rustaveli', lat: '41.301', lon: '69.241' }),
  ], {
    kind: 'address',
    houseNumber: '17',
    street: 'Шота Руставели',
    city: 'Tashkent',
  }, 'UZ');

  assert.equal(point?.lat, 41.301);
  assert.equal(point?.lng, 69.241);
  assert.equal(point?.precision, 'building');
  assert.equal(point?.accuracyM, null);
});

test('exact address rejects a result that cannot prove the requested house', () => {
  const point = selectNominatimPoint([
    result({ road: 'Shota Rustaveli', type: 'road' }),
  ], {
    kind: 'address',
    houseNumber: '17',
    street: 'Shota Rustaveli',
    city: 'Tashkent',
  }, 'UZ');

  assert.equal(point, null);
});

test('exact address rejects a same-number house on another street', () => {
  const point = selectNominatimPoint([
    result({ house: '17', road: 'Amir Temur Avenue' }),
  ], {
    kind: 'address',
    houseNumber: '17',
    street: 'Shota Rustaveli',
    city: 'Tashkent',
  }, 'UZ');

  assert.equal(point, null);
});

test('named entity lookup rejects an unrelated first result', () => {
  const point = selectNominatimPoint([
    result({ name: 'Infinity', type: 'residential', road: 'Some Road' }),
    result({ name: 'Assalom Sohil', type: 'residential', road: 'Another Road', lat: '41.283', lon: '69.308' }),
  ], {
    kind: 'entity',
    name: 'Assalom Sohil',
    city: 'Tashkent',
  }, 'UZ');

  assert.equal(point?.lat, 41.283);
  assert.equal(point?.lng, 69.308);
});

test('country mismatch is rejected even when house and street match', () => {
  const point = selectNominatimPoint([
    result({ house: '17', road: 'Shota Rustaveli', countryCode: 'ge' }),
  ], {
    kind: 'address',
    houseNumber: '17',
    street: 'Shota Rustaveli',
    city: 'Tashkent',
  }, 'UZ');

  assert.equal(point, null);
});

test('cache identity includes validation expectations', () => {
  const a = nominatimCacheKey('Shota Rustaveli 17, Tashkent', 'UZ', {
    kind: 'address', houseNumber: '17', street: 'Shota Rustaveli', city: 'Tashkent',
  });
  const b = nominatimCacheKey('Shota Rustaveli 17, Tashkent', 'UZ', {
    kind: 'address', houseNumber: '71', street: 'Shota Rustaveli', city: 'Tashkent',
  });

  assert.notEqual(a, b);
  assert.match(a, /^geo:v4:uz:/);
});

test('exact address candidate has building precision without invented meter accuracy', () => {
  const [candidate] = geocodeCandidates({
    city: 'Tashkent',
    address: 'Shota Rustaveli 17',
    street: 'Shota Rustaveli',
    houseNumber: '17',
  }, UZ);

  assert.equal(candidate.source, 'address');
  assert.equal(candidate.precision, 'building');
  assert.equal(candidate.approximate, false);
  assert.equal(candidate.accuracyM, null);
  assert.deepEqual(candidate.nominatim, {
    kind: 'address',
    houseNumber: '17',
    street: 'Shota Rustaveli',
    city: 'Tashkent',
  });
});
