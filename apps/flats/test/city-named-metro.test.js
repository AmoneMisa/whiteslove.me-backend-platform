import test from 'node:test';
import assert from 'node:assert/strict';

import { matchDictionaryEntities } from '../src/geo/location-dictionary-resolver.js';
import { geocodeCandidates } from '../src/geo/geocode.js';

const UZ = { code: 'UZ', name: 'Uzbekistan', cities: ['Tashkent'] };

test('the bare city name is not read as the station named after the city', () => {
  const matched = matchDictionaryEntities('Ташкент, Мирабадский район', 'UZ', 'Tashkent');

  assert.equal(matched.metro, null);
  assert.equal(matched.district, 'Mirobod');
  assert.equal(
    matched.locationEntities.some((entity) => entity.type === 'metro'),
    false,
  );
});

test('explicit metro wording still resolves the station that shares the city name', () => {
  const matched = matchDictionaryEntities('метро Ташкент, Мирабадский район', 'UZ', 'Tashkent');

  assert.equal(matched.metro, 'Toshkent');
  assert.equal(
    matched.locationEntities.some((entity) => entity.type === 'metro' && entity.name === 'Toshkent'),
    true,
  );
});

test('a listing naming only its district and complex gains no station anchor', () => {
  const matched = matchDictionaryEntities([
    'Расположение',
    'Ташкент',
    'Мирабад',
    'Супер-локация: Мирабадский р-н',
    'в престижном ЖК NRG Meros. (Бизнес-класс)',
    'Ориентир: ТЦ Аlfraganus , Парк Бобура.',
  ].join('\n'), 'UZ', 'Tashkent');

  assert.equal(matched.metro, null);
  assert.equal(matched.district, 'Mirobod');
  assert.equal(matched.residentialComplex, 'NRG Meros');
});

test('a dropped station cannot outrank the stated district as a geocoding anchor', () => {
  const matched = matchDictionaryEntities('Ташкент, Мирабадский район', 'UZ', 'Tashkent');
  const sources = geocodeCandidates({
    city: 'Tashkent',
    district: matched.district,
    metro: matched.metro,
    locationEntities: matched.locationEntities,
  }, UZ).map((candidate) => candidate.source);

  assert.equal(sources.includes('metro'), false);
  assert.equal(sources[0], 'district');
});
