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

// uybor.uz is a Next.js app: each card links its listing twice (thumbnail
// anchor, then the text anchor) and renders the photo through /_next/image,
// whose `url` parameter holds the real image. The page footer carries an SVG
// store badge that is not a listing photo.
test('uybor.uz cards keep their photo, unwrapped from the Next.js image proxy', () => {
  const card = (id, media, price) => [
    `<a target="_blank" href="/listings/${id}"><figure><div>`,
    `<img alt="Uybor.uz" width="660" height="460" srcset="/_next/image?url=https%3A%2F%2Fapi.uybor.uz%2Fapi%2Fv1%2Fmedia%2Fn%2F${media}.jpg%3Fwidth%3D660%26height%3D460&amp;w=750&amp;q=100 1x, /_next/image?url=https%3A%2F%2Fapi.uybor.uz%2Fapi%2Fv1%2Fmedia%2Fn%2F${media}.jpg%3Fwidth%3D660%26height%3D460&amp;w=1920&amp;q=100 2x" src="/_next/image?url=https%3A%2F%2Fapi.uybor.uz%2Fapi%2Fv1%2Fmedia%2Fn%2F${media}.jpg%3Fwidth%3D660%26height%3D460&amp;w=1920&amp;q=100">`,
    '</div></figure></a>',
    `<a target="_blank" href="/listings/${id}"><div>`,
    `<span>${price} $</span><span>2-комнатная квартира</span><span>60 м²</span><span>Ташкент, Юнусабад</span>`,
    '</div></a>',
  ].join('');
  const html = [
    card(1298063, '1111', 450),
    card(1299284, '2222', 600),
    '<footer><img src="/img/apps/app-store.svg" alt="App Store"><a href="/about">О нас</a></footer>',
  ].join('');

  const listings = extractKnownOwnerHtml(
    html, COUNTRIES.UZ, 'https://uybor.uz/listings?category__eq=7&operationType__eq=rent', 'longRent',
  );
  assert.equal(listings.length, 2);
  assert.deepEqual(listings.map((item) => item.photos), [
    ['https://api.uybor.uz/api/v1/media/n/1111.jpg?width=660&height=460'],
    ['https://api.uybor.uz/api/v1/media/n/2222.jpg?width=660&height=460'],
  ]);
  assert.deepEqual(listings.map((item) => item.price), [450, 600]);
});

test('card images fall back to srcset and never return vector chrome', () => {
  const html = [
    '<article>',
    '<a href="/en/listings/abc"><h3>Chilanzar apartment</h3></a>',
    '<img srcset="https://rentli.uz/images/abc-1x.jpg 1x, https://rentli.uz/images/abc-2x.jpg 2x">',
    '<img src="https://rentli.uz/images/logo.svg">',
    '<p>Rent Tashkent 2 rooms 55 m² 5 000 000 UZS/mo</p>',
    '</article>',
  ].join('');

  const [listing] = extractKnownOwnerHtml(html, COUNTRIES.UZ, 'https://rentli.uz/en/listings');
  assert.deepEqual(listing.photos, ['https://rentli.uz/images/abc-1x.jpg']);
});

// Agency logos and poster avatars are printed inside the card but are not the
// flat's photo; identical across an agency's listings they glue unrelated flats
// into one property cluster.
test('card images skip agency logos and avatars but keep the real photo', () => {
  const html = [
    '<a href="https://realting.uz/property-to-rent/3991012">',
    '<img src="https://static2.realting.com/uploads/logo_in_square/6ca/a02b3e756811.webp">',
    '<img src="https://static2.realting.com/uploads/thumbs/1da/98a95a18993b.webp">',
    '<img src="https://market-images.lunstatic.net/lun-ua/60/60/images/avatars/1839810618468513.png">',
    '<div>2 комнатная квартира в аренду 60 м² $750 в месяц Ташкент</div>',
    '</a>',
  ].join('');

  const [listing] = extractKnownOwnerHtml(
    html, COUNTRIES.UZ, 'https://realting.uz/tashkent/property-to-rent/apartments', 'longRent',
  );
  assert.deepEqual(listing.photos, ['https://static2.realting.com/uploads/thumbs/1da/98a95a18993b.webp']);
});

test('a card id and a street number are not glued onto the price (m2bomber)', () => {
  const html = [
    '<div class="item-card-long">',
    '<a href="/obj/1408381297/view/flat-rent/x"><h3>Довготривала оренда 1к квартири на вул. Одеська 3 • ID 35056554</h3></a>',
    '<address class="fullcard-address">Одеська вулиця, Зарванці, вул. Одеська 3 35056554</address>',
    '<div class="fullcard-price-wrap"><p><span id="priceValueHolder">18 000 ₴</span></p></div>',
    '<p>52 м² 1-кімнатна</p>',
    '</div>',
  ].join('');
  const [listing] = extractKnownOwnerHtml(html, { ...COUNTRIES.UA, code: 'UA' }, 'https://ua.m2bomber.com/search/', 'longRent');
  assert.equal(listing.price, 18_000);
  assert.equal(listing.currency, 'UAH');
});
