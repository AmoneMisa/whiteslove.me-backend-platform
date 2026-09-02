import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/geo/countries.js';
import { geocodeCandidates } from '../src/geo/geocode.js';
import { makeListing } from '../src/listing/normalize.js';

function listing(city) {
  return makeListing({
    id: `city-${city}`,
    source: 'telegram',
    country: 'UZ',
    city,
    title: 'Квартира в аренду',
    description: '',
  });
}

test('canonicalizes Tashkent aliases before geocoding', () => {
  assert.equal(listing('Toshkent').city, 'Tashkent');
  assert.equal(listing('Ташкент').city, 'Tashkent');
  assert.equal(listing('tashkent').city, 'Tashkent');
});

test('uses the canonical city name in geocoding candidates', () => {
  const candidates = geocodeCandidates({ id: 'alias', city: 'Toshkent' }, COUNTRIES.UZ);
  const city = candidates.find((candidate) => candidate.source === 'city');

  assert.ok(city);
  assert.equal(city.q, 'Tashkent, Uzbekistan');
});

test('canonicalizes known Yangiyul spelling and keeps a genuinely unknown source city', () => {
  assert.equal(listing('Yangiyul').city, 'Yangiyol');
  assert.equal(listing('Imaginaryville').city, 'Imaginaryville');
});
