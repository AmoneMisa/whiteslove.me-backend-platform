import test from 'node:test';
import assert from 'node:assert/strict';

import { matchDictionaryEntities } from '../src/geo/location-dictionary-resolver.js';
import { parseLocation } from '../src/geo/locations.js';

const ADDRESS_THEN_METRO = 'Адреса: вул. Лук\'янівська, 22. Пішa доступність до станцій метро «Лук\'янівська» (15–20 хвилин).';

test('a station named in a street address does not hide its later metro mention', () => {
  assert.equal(matchDictionaryEntities(ADDRESS_THEN_METRO, 'UA', 'Kyiv').metro, 'Lukianivska');
});

test('a bare street mention alone still is not a station', () => {
  assert.equal(matchDictionaryEntities('Адреса: вул. Лук\'янівська, 22.', 'UA', 'Kyiv').metro, null);
});

test('a Kyiv station outside the legacy dozen resolves with metro wording', () => {
  assert.equal(matchDictionaryEntities('Поруч метро Контрактова площа', 'UA', 'Kyiv').metro, 'Kontraktova Ploshcha');
});

test('a district named in passing does not become the listing street', () => {
  const location = parseLocation('Швидкий спуск на Поділ та Глибочицьку. Тихий район Татарка.', 'UA', 'Kyiv');
  assert.notEqual(location.street, 'Подільський провулок');
  assert.notEqual(location.street, 'Татарська вулиця');
});

test('an area only travelled to is not the microdistrict', () => {
  const travelled = matchDictionaryEntities('Швидкий спуск на Поділ. Тихий район Татарка.', 'UA', 'Kyiv');
  assert.notEqual(travelled.microdistrict, 'Podil');
  assert.equal(matchDictionaryEntities('Київ, Поділ, вул. Сагайдачного', 'UA', 'Kyiv').microdistrict, 'Podil');
});
