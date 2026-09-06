import test from 'node:test';
import assert from 'node:assert/strict';

import {makeListing} from '../src/listing/normalize.js';

function base(overrides = {}) {
  return {
    id: 'photo-normalization-test',
    source: 'olx',
    country: 'UZ',
    title: 'Квартира в аренду',
    description: 'Тестовое объявление',
    propertyType: 'flat',
    dealType: 'longRent',
    byAgency: false,
    price: 500,
    currency: 'USD',
    city: 'Tashkent',
    url: 'https://www.olx.uz/d/obyavlenie/test.html',
    ...overrides,
  };
}

test('normalizes OLX prerender photo objects into usable URLs', () => {
  const listing = makeListing(base({
    photos: [
      {link: 'https://ireland.apollo.olxcdn.com/v1/files/a/image;s={width}x{height}'},
      {link: 'https://ireland.apollo.olxcdn.com/v1/files/b/image;s={width}x{height}'},
    ],
  }));

  assert.equal(
    listing.photo,
    'https://ireland.apollo.olxcdn.com/v1/files/a/image;s=800x600',
  );
  assert.deepEqual(listing.photos, [
    'https://ireland.apollo.olxcdn.com/v1/files/a/image;s=800x600',
    'https://ireland.apollo.olxcdn.com/v1/files/b/image;s=800x600',
  ]);
});

test('keeps existing string photo URLs and removes duplicates', () => {
  const listing = makeListing(base({
    photo: '/api/tg-photo/channel/42',
    photos: ['/api/tg-photo/channel/42', '/api/tg-photo/channel/42'],
  }));

  assert.equal(listing.photo, '/api/tg-photo/channel/42');
  assert.deepEqual(listing.photos, ['/api/tg-photo/channel/42']);
});
