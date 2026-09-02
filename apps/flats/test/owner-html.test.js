import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/geo/countries.js';
import { extractKnownOwnerHtml } from '../src/scrapers/owner-html.js';

test('owner SSR fallback extracts a rental card with stable detail URL', () => {
  const html = [
    '<article>',
    '<a href="/en/listings/abc"><h3>Chilanzar apartment</h3></a>',
    '<p>Rent Tashkent 2 rooms 55 m² 5 000 000 UZS/mo</p>',
    '<img src="https://rentli.uz/images/abc.jpg">',
    '</article>',
  ].join('');

  const listings = extractKnownOwnerHtml(html, COUNTRIES.UZ, 'https://rentli.uz/en/listings');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].rooms, 2);
  assert.equal(listings[0].areaSqm, 55);
  assert.equal(listings[0].byAgency, false);
  assert.match(listings[0].url, /\/en\/listings\/abc$/);
});

test('owner SSR fallback accepts tenge cards from KN owner catalogue', () => {
  const html = [
    '<article>',
    '<a href="/almaty/id-123"><h3>2-комнатная квартира, Коктем-2</h3></a>',
    '<p>Аренда квартира 2 комнаты 48 м² Частное лицо 300 000 ₸ в месяц</p>',
    '</article>',
  ].join('');

  const listings = extractKnownOwnerHtml(
    html,
    COUNTRIES.KZ,
    'https://www.kn.kz/almaty/arenda-kvartir-bez-posrednikov-s-foto',
  );
  assert.equal(listings.length, 1);
  assert.equal(listings[0].rooms, 2);
  assert.equal(listings[0].areaSqm, 48);
  assert.equal(listings[0].byAgency, false);
});

test('owner SSR fallback accepts Kyrgyz som daily cards', () => {
  const html = [
    '<article>',
    '<a href="/bishkek/kvartira/100123"><h3>1-комн. квартира, Бишкек</h3></a>',
    '<p>Квартира посуточно 1 комн. 50 м² 4 000 сом / сутки</p>',
    '</article>',
  ].join('');

  const listings = extractKnownOwnerHtml(
    html,
    COUNTRIES.KG,
    'https://sutochno.kg/bishkek/',
  );
  assert.equal(listings.length, 1);
  assert.equal(listings[0].rooms, 1);
  assert.equal(listings[0].areaSqm, 50);
  assert.equal(listings[0].byAgency, false);
});

test('owner SSR fallback does not run on arbitrary custom domains', () => {
  const html = '<article><h3>Apartment</h3><p>Rent 2 rooms 500 USD</p></article>';
  assert.deepEqual(
    extractKnownOwnerHtml(html, COUNTRIES.UA, 'https://example.com/listings'),
    [],
  );
});
