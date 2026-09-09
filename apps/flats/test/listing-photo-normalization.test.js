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

test('normalizes OLX prerender photo objects and routes them through the photo proxy', () => {
  const listing = makeListing(base({
    photos: [
      {link: 'https://ireland.apollo.olxcdn.com/v1/files/a/image;s={width}x{height}'},
      {link: 'https://ireland.apollo.olxcdn.com/v1/files/b/image;s={width}x{height}'},
    ],
  }));

  // apollo.olxcdn.com can 404 for reasons entirely outside our control (a
  // removed ad, a rotated asset id, a transient edge miss) with nothing to
  // catch it, so OLX photos are proxied+cached the same way Telegram photos
  // already are, instead of hotlinking the CDN URL straight to the browser.
  const proxied = (url) => `/api/olx-photo?src=${encodeURIComponent(url)}`;

  assert.equal(
    listing.photo,
    proxied('https://ireland.apollo.olxcdn.com/v1/files/a/image;s=800x600'),
  );
  assert.deepEqual(listing.photos, [
    proxied('https://ireland.apollo.olxcdn.com/v1/files/a/image;s=800x600'),
    proxied('https://ireland.apollo.olxcdn.com/v1/files/b/image;s=800x600'),
  ]);
});

test('leaves non-OLX-CDN photo URLs unproxied', () => {
  const listing = makeListing({
    ...base(),
    source: 'telegram',
    photos: ['https://example.com/photo.jpg'],
  });

  assert.equal(listing.photo, 'https://example.com/photo.jpg');
});

test('keeps existing string photo URLs and removes duplicates', () => {
  const listing = makeListing(base({
    photo: '/api/tg-photo/channel/42',
    photos: ['/api/tg-photo/channel/42', '/api/tg-photo/channel/42'],
  }));

  assert.equal(listing.photo, '/api/tg-photo/channel/42');
  assert.deepEqual(listing.photos, ['/api/tg-photo/channel/42']);
});
