import test from 'node:test';
import assert from 'node:assert/strict';

import { makeListing } from '../src/listing/normalize.js';

test('named park replaces generic park in nearby places', () => {
  const listing = makeListing({
    id: 'chernivtsi-poi-dedupe',
    source: 'olx',
    country: 'UA',
    title: 'Продаж 2-кім. квартири 47 м.кв., в. Полетаєва',
    description: 'Поруч є садочки та школи, супермаркети, парк Жовтневий.',
    propertyType: 'flat',
    dealType: 'sale',
    city: 'Черновцы',
    nearby: ['Park', 'School', 'Парк Жовтневий'],
  });

  assert.deepEqual(listing.nearby, ['School', 'Парк Жовтневий']);
});

test('address parsing rejects floor and basement prose', () => {
  const listing = makeListing({
    id: 'chernivtsi-address-noise',
    source: 'olx',
    country: 'UA',
    title: 'Продаж 2х кім кварт(по плану) Чернівці, центр',
    description: 'Центр. перший поверх так і підвал. 42м2.',
    propertyType: 'flat',
    dealType: 'sale',
    city: 'Черновцы',
  });

  assert.equal(listing.address, null);
});
