import test from 'node:test';
import assert from 'node:assert/strict';

import { makeListing } from '../src/normalize.js';

function listing({ city = 'Одесса', title = 'Продам квартиру', description = '' } = {}) {
  return makeListing({
    id: `odesa-${title}-${description}`,
    source: 'telegram',
    country: 'UA',
    city,
    title,
    description,
  });
}

test('keeps Odesa suburbs separate from administrative districts and returns all location entities', () => {
  const result = listing({
    description: 'Продам квартиру на Котовского возле Ривьеры, Крыжановка',
  });

  assert.equal(result.city, 'Odesa');
  assert.equal(result.locality, 'Крижанівка');
  assert.ok(result.localAreas.includes('Житловий масив Котовського'));
  assert.ok(result.suburbs.includes('Крижанівка'));
  assert.ok(result.nearby.includes('ТРЦ Рів’єра'));
  assert.ok(result.searchClusters.includes('Одеса — північно-східна агломерація'));
  assert.ok(result.locationEntities.some((item) => item.type === 'local_area' && item.name === 'Житловий масив Котовського'));
  assert.ok(result.locationEntities.some((item) => item.type === 'poi.shopping_mall' && item.name === 'ТРЦ Рів’єра'));
  assert.ok(result.locationEntities.some((item) => item.type === 'suburb' && item.name === 'Крижанівка'));
  assert.notEqual(result.district, 'Крижанівка');
});

test('normalizes Riviera residential complex separately from the shopping mall', () => {
  const result = listing({ description: 'ЖК Сады Ривьеры, Фонтанка, новая квартира' });
  assert.equal(result.residenceComplex, 'Сади Рів’єри');
  assert.equal(result.locality, 'Фонтанка');
  assert.ok(result.suburbs.includes('Фонтанка'));
  assert.ok(!result.nearby.includes('ТРЦ Рів’єра'));
});

test('distinguishes city Tairova from suburban Tairove', () => {
  const cityArea = listing({ description: 'Таирова, квартира рядом с Королёва' });
  assert.equal(cityArea.microdistrict, 'Таїрова');
  assert.equal(cityArea.locality, null);

  const suburb = listing({ description: 'с. Таирово, частный дом' });
  assert.equal(suburb.locality, 'Таїрове');
  assert.ok(suburb.suburbs.includes('Таїрове'));
});

test('canonicalizes historical Ukrainian city names through the shared lexicon', () => {
  assert.equal(listing({ city: 'Одесса' }).city, 'Odesa');

  const dnipro = makeListing({ id: 'dnipro-old', source: 'telegram', country: 'UA', city: 'Днепропетровск', title: 'Квартира', description: '' });
  const rivne = makeListing({ id: 'rivne-old', source: 'telegram', country: 'UA', city: 'Ровно', title: 'Квартира', description: '' });
  const kropyvnytskyi = makeListing({ id: 'kirovohrad-old', source: 'telegram', country: 'UA', city: 'Кировоград', title: 'Квартира', description: '' });

  assert.equal(dnipro.city, 'Dnipro');
  assert.equal(rivne.city, 'Rivne');
  assert.equal(kropyvnytskyi.city, 'Kropyvnytskyi');
});
