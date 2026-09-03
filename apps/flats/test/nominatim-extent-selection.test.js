import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeCandidates } from '../src/geo/geocode.js';
import { selectNominatimPoint } from '../src/geo/nominatim-client.js';

const UZ = {
  code: 'UZ',
  name: 'Uzbekistan',
  cities: ['Tashkent'],
  center: { lat: 41.2995, lng: 69.2401 },
};

/** Bounding box for a square of `radiusM` around a point, in Nominatim order. */
function boxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [
    String(lat - dLat), String(lat + dLat),
    String(lon - dLon), String(lon + dLon),
  ];
}

function result({
  lat = 41.30,
  lon = 69.24,
  name = null,
  radiusM = null,
  importance = 0,
  type = 'residential',
  city = 'Tashkent',
} = {}) {
  return {
    lat: String(lat),
    lon: String(lon),
    name,
    display_name: [name, city, 'Uzbekistan'].filter(Boolean).join(', '),
    addresstype: type,
    type,
    osm_type: 'way',
    osm_id: 1,
    importance,
    ...(radiusM == null ? {} : { boundingbox: boxAround(lat, lon, radiusM) }),
    address: { city, country_code: 'uz' },
  };
}

test('a district-sized polygon does not win a residential complex lookup', () => {
  const point = selectNominatimPoint([
    // Same name, but a whole administrative area and far more "important".
    result({ name: 'Assalom Sohil', radiusM: 6000, importance: 0.7, type: 'suburb' }),
    result({
      name: 'Assalom Sohil', lat: 41.282995, lon: 69.30842,
      radiusM: 140, importance: 0.1,
    }),
  ], {
    kind: 'entity',
    name: 'Assalom Sohil',
    city: 'Tashkent',
    level: 'complex',
  }, 'UZ');

  assert.ok(Math.abs(point.lat - 41.282995) < 1e-9);
  assert.ok(Math.abs(point.lng - 69.30842) < 1e-9);
});

test('a shop-sized match does not win a district lookup', () => {
  const point = selectNominatimPoint([
    result({ name: 'Chilonzor', radiusM: 30, importance: 0.6, type: 'shop' }),
    result({ name: 'Chilonzor', lat: 41.28, lon: 69.20, radiusM: 5000, type: 'suburb' }),
  ], {
    kind: 'entity',
    name: 'Chilonzor',
    city: 'Tashkent',
    level: 'district',
  }, 'UZ');

  assert.ok(Math.abs(point.lat - 41.28) < 1e-9);
});

test('a point-like anchor is rejected outright when its footprint is a whole region', () => {
  const point = selectNominatimPoint([
    result({ name: 'Infinity', radiusM: 40_000, type: 'boundary' }),
  ], {
    kind: 'entity',
    name: 'Infinity',
    city: 'Tashkent',
    level: 'complex',
  }, 'UZ');

  assert.equal(point, null);
});

test('the matched footprint is reported so the accuracy radius can stay honest', () => {
  const point = selectNominatimPoint([
    result({ name: 'Assalom Sohil', radiusM: 900 }),
  ], {
    kind: 'entity',
    name: 'Assalom Sohil',
    city: 'Tashkent',
    level: 'complex',
  }, 'UZ');

  assert.ok(point.extentM > 800 && point.extentM < 1400, `extent ${point.extentM}`);
});

test('a result without geometry keeps the previous behaviour and invents no accuracy', () => {
  const point = selectNominatimPoint([
    result({ name: 'Assalom Sohil' }),
  ], {
    kind: 'entity',
    name: 'Assalom Sohil',
    city: 'Tashkent',
    level: 'complex',
  }, 'UZ');

  assert.equal(point.extentM, null);
  assert.equal(point.accuracyM, null);
});

test('broad candidates carry their semantic level to the geocoder', () => {
  const candidates = geocodeCandidates({
    city: 'Tashkent',
    district: 'Yashnabad',
    metro: 'Chilonzor',
    suburbs: ['Sergeli outskirts'],
  }, UZ);

  const metro = candidates.find((candidate) => candidate.source === 'metro');
  const suburb = candidates.find((candidate) => candidate.source === 'suburb');
  const district = candidates.find((candidate) => candidate.source === 'district');

  assert.equal(metro.nominatim.level, 'station');
  assert.equal(suburb.nominatim.level, 'locality');
  assert.equal(suburb.precision, 'locality');
  assert.equal(district.nominatim.level, 'district');
});
