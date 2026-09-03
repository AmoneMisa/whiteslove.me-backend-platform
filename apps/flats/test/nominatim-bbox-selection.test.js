import test from 'node:test';
import assert from 'node:assert/strict';

import { selectNominatimBbox } from '../src/geo/nominatim-client.js';

function result({ city, countryCode = 'uz', bbox }) {
  return {
    display_name: `${city}, Uzbekistan`,
    boundingbox: bbox,
    address: {
      city,
      ...(countryCode ? { country_code: countryCode } : {}),
    },
  };
}

test('city bbox selection skips an earlier result for another city', () => {
  const bbox = selectNominatimBbox([
    result({ city: 'Samarkand', bbox: ['39.5', '39.8', '66.8', '67.2'] }),
    result({ city: 'Tashkent', bbox: ['41.1', '41.5', '69.0', '69.5'] }),
  ], 'UZ', 'Tashkent');

  assert.deepEqual(bbox, [41.1, 69.0, 41.5, 69.5]);
});

test('city bbox selection requires country evidence when country is known', () => {
  const bbox = selectNominatimBbox([
    result({ city: 'Tashkent', countryCode: null, bbox: ['41.1', '41.5', '69.0', '69.5'] }),
  ], 'UZ', 'Tashkent');

  assert.equal(bbox, null);
});

test('city bbox selection accepts canonical local-language city alias', () => {
  const bbox = selectNominatimBbox([
    result({ city: 'Toshkent', bbox: ['41.1', '41.5', '69.0', '69.5'] }),
  ], 'UZ', 'Tashkent');

  assert.deepEqual(bbox, [41.1, 69.0, 41.5, 69.5]);
});
