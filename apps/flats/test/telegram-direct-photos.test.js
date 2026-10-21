import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/geo/countries.js';
import { telegramMessageToListings } from '../src/scrapers/telegram.js';

const TEXT = 'Сдаётся 2-комнатная квартира в Ташкенте, 60 м², 500$ в месяц, без комиссии. Тел. +998901234567';
const channel = { name: 'arenda_samarkand', city: 'Tashkent', dealType: 'longRent' };

function photosOf(message) {
  const [listing] = telegramMessageToListings({ id: 7155, text: TEXT, date: '2026-10-19T09:18:39.000Z', ...message }, channel, COUNTRIES.UZ);
  return listing.photos;
}

test('photos go through the worker proxy by default', () => {
  assert.deepEqual(photosOf({ hasPhoto: true, photoIds: [7155, 7156] }), [
    '/api/tg-photo/arenda_samarkand/7155',
    '/api/tg-photo/arenda_samarkand/7156',
  ]);
});

test('while the worker answers from the web preview its Telegram CDN URLs are shown directly', () => {
  assert.deepEqual(
    photosOf({
      hasPhoto: true,
      photoIds: [7155, 7156, 7157],
      photoUrls: ['https://cdn4.telesco.pe/file/a.jpg', null, 'https://evil.example/b.jpg'],
    }),
    [
      'https://cdn4.telesco.pe/file/a.jpg',
      '/api/tg-photo/arenda_samarkand/7156',
      '/api/tg-photo/arenda_samarkand/7157',
    ],
    'a missing or non-Telegram URL falls back to the proxy',
  );
});
