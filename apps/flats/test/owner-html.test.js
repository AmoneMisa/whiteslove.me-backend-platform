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

test('owner SSR fallback splits myhouse.kg cards by their it-grid-item marker', () => {
  // myhouse.kg's real card is a bare <div class="j-item it-grid-item ...">
  // (no <article>/<li>), so before the DIV_CARD_HOSTS entry existed the
  // generic structuredBlocks() scan found nothing and fell through to the
  // text-window fallback, which produced duplicate near-identical windows
  // around the single price mention.
  const html = [
    '<div class="it-list j-list"><div class="it-view-gallery">',
    '<div class="j-item it-grid-item rp-it-grid-item" data-id="529">',
    '<a class="it-item-title" href="/bishkek/rent/apartment/1-komnata-529.html">1 комната, Бишкек</a>',
    '<span>Аренда 1 комн. 30 м²</span>',
    '<span>7 000 сом</span>',
    '</div>',
    '</div></div>',
  ].join('');

  const listings = extractKnownOwnerHtml(html, COUNTRIES.KG, 'https://myhouse.kg/rent/apartment/');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].rooms, 1);
  assert.equal(listings[0].areaSqm, 30);
  assert.match(listings[0].url, /1-komnata-529\.html$/);
});

test('owner SSR fallback does not run on arbitrary custom domains', () => {
  const html = '<article><h3>Apartment</h3><p>Rent 2 rooms 500 USD</p></article>';
  assert.deepEqual(
    extractKnownOwnerHtml(html, COUNTRIES.UA, 'https://example.com/listings'),
    [],
  );
});

// hata.uz is a Next.js catalogue with Tailwind utility classes; every card has
// two anchors to /listings/object/<slug>-<id> (an inset overlay and the photo).
test('hata.uz cards are read through their /listings/object/ links', () => {
  const card = (id, slug, rooms, area, price) => [
    '<div><article>',
    `<a target="_blank" aria-label="${rooms}-комнатная квартира, ${area} м²" href="/listings/object/${slug}-${id}"></a>`,
    `<div><a target="_blank" tabindex="-1" href="/listings/object/${slug}-${id}"></a>`,
    `<img src="/api/image?url=https%3A%2F%2Ffirsts3.ru%2F${id}.jpg" alt="x"/></div>`,
    '<div><span>Яккасарайский район, Ташкент</span></div>',
    `<span>${rooms}-комнатная квартира, ${area} м²</span>`,
    '<div><span>4/9<!-- --> <!-- -->эт.</span><span>Евроремонт</span></div>',
    `<div><span>$ ${price}/мес</span></div>`,
    '</article></div>',
  ].join('');
  const html = [
    '<nav><a href="/listings/sale/flats">Купить</a><a href="/listings/rent/flats">Снять</a></nav>',
    card(7653650, 'novza-metro-kvartira', 3, 75, 400),
    card(7652131, 'sdaetsia-2kh-komnatnaia', 2, 68, 700),
    '<footer><a href="/listings/rent/tashkent?page=2">2</a></footer>',
  ].join('');

  const listings = extractKnownOwnerHtml(
    html, COUNTRIES.UZ, 'https://hata.uz/listings/rent/flats/tashkent', 'longRent',
  );
  assert.equal(listings.length, 2);
  assert.deepEqual(listings.map((item) => item.rooms), [3, 2]);
  assert.deepEqual(listings.map((item) => item.price), [400, 700]);
  assert.ok(listings.every((item) => item.currency === 'USD' && item.dealType === 'longRent'));
  assert.match(listings[0].url, /^https:\/\/hata\.uz\/listings\/object\/novza-metro-kvartira-7653650$/);
});

// realting.uz links each card to an absolute /property-to-rent/<id> URL. The
// same page carries Telegram share links that embed that URL inside a query
// string; they must not be mistaken for cards.
test('realting.uz cards are read through absolute /property-to-rent/ links', () => {
  const card = (id, rooms, area, price) => [
    `<a href="https://realting.uz/property-to-rent/${id}" onclick="sendGtmViewEvent(${id})">`,
    '<div itemscope itemtype="https://schema.org/ImageObject">',
    `<img src="https://static2.realting.com/uploads/thumbs/${id}.webp" alt="Квартира"></div>`,
    '<div><div>Квартира аренда</div><div>Ташкент, Узбекистан</div>',
    `<div><div><span>${rooms}</span></div><div><span>${area} м²</span></div><div><span>3/5</span></div></div></div>`,
    `<div><div>${rooms} комнатная квартира в аренду ${area} кв.м. ${price} $</div></div>`,
    `<div><div>$${price}</div><span> в месяц </span></div>`,
    '</a>',
    `<a href="https://telegram.me/agent?text=https%3A%2F%2Frealting.uz%2Fproperty-to-rent%2F${id}">Написать</a>`,
  ].join('');
  const html = [
    '<a href="https://realting.uz/tashkent/property-to-rent/apartments/2-bedrooms">2 спальни</a>',
    card(3991012, 3, 120, '1 700'),
    card(3993987, 2, 60, 750),
  ].join('');

  const listings = extractKnownOwnerHtml(
    html, COUNTRIES.UZ, 'https://realting.uz/tashkent/property-to-rent/apartments', 'longRent',
  );
  assert.equal(listings.length, 2);
  assert.deepEqual(listings.map((item) => item.rooms), [3, 2]);
  assert.deepEqual(listings.map((item) => item.price), [1700, 750]);
  assert.match(listings[0].url, /^https:\/\/realting\.uz\/property-to-rent\/3991012$/);
});

test('HTML entity ellipses in card text are decoded', () => {
  const html = [
    '<a href="https://realting.uz/property-to-rent/1">',
    '<div>2 комнатная квартира аренда 60 м² $750 в месяц Ташкент, Бобур&hellip;</div>',
    '</a>',
  ].join('');
  const [listing] = extractKnownOwnerHtml(
    html, COUNTRIES.UZ, 'https://realting.uz/tashkent/property-to-rent/apartments', 'longRent',
  );
  assert.ok(listing);
  assert.doesNotMatch(JSON.stringify(listing), /&hellip;/);
});
