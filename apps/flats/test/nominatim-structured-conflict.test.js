import test from 'node:test';
import assert from 'node:assert/strict';

import { selectNominatimPoint } from '../src/geo/nominatim-client.js';

function result({ name = null, road = null, city = 'Tashkent', displayName = null } = {}) {
  return {
    lat: '41.30',
    lon: '69.24',
    name,
    display_name: displayName || [name, road, city, 'Uzbekistan'].filter(Boolean).join(', '),
    addresstype: 'residential',
    type: 'residential',
    address: {
      ...(road ? { road } : {}),
      ...(city ? { city } : {}),
      country_code: 'uz',
    },
  };
}

test('structured entity name cannot be overridden by another name appearing only in display text', () => {
  const point = selectNominatimPoint([
    result({
      name: 'Infinity',
      city: 'Tashkent',
      displayName: 'Infinity, near Assalom Sohil, Tashkent, Uzbekistan',
    }),
  ], {
    kind: 'entity',
    name: 'Assalom Sohil',
    city: 'Tashkent',
  }, 'UZ');

  assert.equal(point, null);
});

test('structured street cannot be overridden by another street appearing only in display text', () => {
  const candidate = result({
    road: 'Amir Temur Avenue',
    city: 'Tashkent',
    displayName: '17, Amir Temur Avenue, near Shota Rustaveli, Tashkent, Uzbekistan',
  });
  candidate.address.house_number = '17';

  const point = selectNominatimPoint([candidate], {
    kind: 'address',
    houseNumber: '17',
    street: 'Shota Rustaveli',
    city: 'Tashkent',
  }, 'UZ');

  assert.equal(point, null);
});

test('structured city cannot be overridden by requested city appearing only in display text', () => {
  const candidate = result({
    road: 'Shota Rustaveli',
    city: 'Samarkand',
    displayName: '17, Shota Rustaveli, Samarkand, route to Tashkent, Uzbekistan',
  });
  candidate.address.house_number = '17';

  const point = selectNominatimPoint([candidate], {
    kind: 'address',
    houseNumber: '17',
    street: 'Shota Rustaveli',
    city: 'Tashkent',
  }, 'UZ');

  assert.equal(point, null);
});
