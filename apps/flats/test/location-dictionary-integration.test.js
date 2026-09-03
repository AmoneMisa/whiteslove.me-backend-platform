import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocation, cityLocations } from '../src/geo/locations.js';
import { makeListing } from '../src/listing/normalize.js';

test('parseLocation propagates multiple shared dictionary entity types', () => {
  const loc = parseLocation('Юнусабад 19, ЖК Хон Сарой, рядом метро Шахристан', 'UZ');
  assert.ok(loc.city);
  assert.ok(loc.microdistrict);
  assert.ok(loc.residentialComplex);
  assert.ok(loc.metro);
});

test('normalized listing exposes shared location fields', () => {
  const listing = makeListing({
    id: 'test-1', source: 'telegram', country: 'UA',
    title: 'Оренда квартири',
    description: 'Київська область, Ірпінь, Річ Таун, 2 кімнати, 18000 грн',
    price: 18000, currency: 'UAH',
  });
  assert.ok(listing.region);
  assert.ok(listing.city);
  assert.ok(listing.microdistrict);
});

test('cityLocations exposes shared dictionaries in the backend UI shape', () => {
  const uz = cityLocations('UZ');
  assert.ok(Array.isArray(uz.Tashkent?.microdistricts));
  assert.ok(Array.isArray(uz.Tashkent?.residentialComplexes));

  const ua = cityLocations('UA');
  assert.ok(Array.isArray(ua.Kharkiv?.microdistricts));
});
