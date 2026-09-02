import test from 'node:test';
import assert from 'node:assert/strict';

import { makeListing } from '../src/listing/normalize.js';

test('normalizes Vorobiovi Hory and abbreviated Akademika Pavlova metro together', () => {
  const listing = makeListing({
    id: 'kharkiv-vorobiovi-hory-ak-pavlova',
    source: 'telegram',
    country: 'UA',
    city: 'Харьков',
    title: 'Продам квартиру',
    description: 'ЖК "Воробьёвы Горы", м. Ак. Павлова',
  });

  assert.equal(listing.city, 'Kharkiv');
  assert.equal(listing.residenceComplex, 'Vorobiovi Hory');
  assert.equal(listing.metro, 'Akademika Pavlova');
});

test('bare Akademika Pavlova remains an area while explicit metro context marks the station', () => {
  const area = makeListing({
    id: 'kharkiv-ak-pavlova-area',
    source: 'telegram',
    country: 'UA',
    city: 'Kharkiv',
    title: 'Квартира',
    description: 'Академика Павлова, рядом рынок',
  });
  assert.equal(area.microdistrict, 'Akademika Pavlova');
  assert.equal(area.metro, null);

  const metro = makeListing({
    id: 'kharkiv-ak-pavlova-metro',
    source: 'telegram',
    country: 'UA',
    city: 'Kharkiv',
    title: 'Квартира',
    description: 'ст.м. Академіка Павлова, 5 хвилин',
  });
  assert.equal(metro.metro, 'Akademika Pavlova');
});
