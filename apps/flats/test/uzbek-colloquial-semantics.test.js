import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyChildren,
  parseCondition,
  parseExplicitDistrict,
  parseKvartal,
} from '../src/listing/textparse-overrides.js';
import {makeListing} from '../src/listing/normalize.js';

const text = 'Юнусобод 13квартил Туркистон метроси якин 1 этаж 2 хонали.Ремонт дан чиккан.Oilaga .Bollar';

test('recovers district, quarter, condition and children from colloquial Uzbek Telegram text', () => {
  assert.equal(parseExplicitDistrict(text, 'UZ'), 'Yunusabad');
  assert.equal(parseKvartal(text), '13 kvartal');
  assert.equal(parseCondition(text), 'good');
  assert.equal(classifyChildren(text), true);

  const listing = makeListing({
    id: 'yunusabad-colloquial',
    source: 'telegram',
    country: 'UZ',
    title: text,
    description: text,
    city: 'Tashkent',
    dealType: 'longRent',
    kvartal: parseKvartal(text),
    childrenAllowed: classifyChildren(text),
    condition: parseCondition(text),
  });

  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Yunusabad');
  assert.equal(listing.metro, 'Turkiston');
  assert.equal(listing.kvartal, '13 kvartal');
  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, 1);
  assert.equal(listing.audience, 'family');
  assert.equal(listing.childrenAllowed, true);
  assert.equal(listing.condition, 'good');
});

test('bollar alone is not enough to claim children are allowed', () => {
  assert.equal(classifyChildren('2 xonali kvartira. Bollar.'), null);
});
