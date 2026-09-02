import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichListingDetails, __listingEnrichmentTest as detail} from '../src/listing/listing-enrichment.js';

test('extracts bedrooms, bathrooms and 5\\5 floor notation', () => {
  const listing = enrichListingDetails({
    title: 'Квартира',
    description: 'Спальни: 3\nКоличество санузлов: 2\nЭтаж 5\\5',
    price: 700,
    currency: 'USD',
  });

  assert.equal(listing.bedrooms, 3);
  assert.equal(listing.bathrooms, 2);
  assert.equal(listing.floor, 5);
  assert.equal(listing.totalFloors, 5);
});

test('extracts compact Uzbek rooms/floor/area and mixed family-or-women audience', () => {
  const listing = enrichListingDetails({
    title: 'Уч тепа Аренда 22кв 3//4//4// 500$ Оелага Кизларга берилади Уйда Хамма шароешти бор',
    description: 'Маклер +998504553244 Риелтор',
    price: 500,
    currency: 'USD',
    rooms: null,
    areaSqm: null,
    floor: null,
    totalFloors: null,
    audience: null,
  });

  assert.equal(listing.rooms, 3);
  assert.equal(listing.areaSqm, 22);
  assert.equal(listing.floor, 4);
  assert.equal(listing.totalFloors, 4);
  assert.equal(listing.audience, 'family');
  assert.deepEqual(listing.audienceAlternatives, ['family', 'women']);
  assert.equal(listing.commission, true);
});

test('extracts realtor commission size and recognizes broker fees without percentages', () => {
  // Numeric commission percentage extraction is a backend-local supplement —
  // the shared lexicon only detects commission as a boolean.
  assert.equal(detail.parseCommissionPercent('Комиссия риелтора: 50%'), 50);
  assert.equal(detail.parseCommissionPercent('50 % риэлтору'), 50);
  assert.equal(detail.parseCommissionPercent('Риелтор 50/50'), 50);

  // Boolean commission detection now comes from the shared lexicon, exercised
  // here at the enrichListingDetails integration level.
  const listing = enrichListingDetails({
    title: 'Аренда Кв 2 Хонали',
    description: 'Телевизор, Стиралка\n$300+$150 Маклерский',
    commission: null,
    commissionPercent: null,
  });
  assert.equal(listing.commission, true);
  assert.equal(listing.commissionPercent, null);

  const noCommission = enrichListingDetails({
    title: 'Сдам квартиру',
    description: 'Без комиссии, собственник',
    commission: null,
  });
  assert.equal(noCommission.commission, false);
});

test('does not promote phones, landmarks or floor facts to address', () => {
  // Address parsing now comes from the shared lexicon (exercised there in
  // its own regression suite); this proves the integration doesn't leak a
  // phone number or an unrelated floor/landmark fact into the address field.
  const phoneOnly = enrichListingDetails({
    title: 'Квартира',
    description: 'Адрес: +998 90 123 45 67\nТелефон для связи',
  });
  assert.equal(phoneOnly.address, null);

  const withStreet = enrichListingDetails({
    title: 'Квартира',
    description: 'Адрес: ул. Шота Руставели 12',
  });
  assert.match(withStreet.address, /Шота Руставели/);
});

test('extracts cadastral availability and first rental', () => {
  assert.equal(detail.parseCadastral('Кадастр есть, документы готовы'), true);
  assert.equal(detail.parseCadastral('Продажа без кадастра'), false);
  assert.equal(detail.parseFirstRental('Первая сдача после ремонта'), true);
  assert.equal(detail.parseFirstRental('Сдаётся впервые'), true);
});

test('recognizes Uzbek room-share wording and only flags a low-price single-woman share', () => {
  const twoWomen = enrichListingDetails({
    title: 'kvartiraga 2ta qiz kere',
    description: 'manzil yunusobod 13-kvartal, birga yashashga 2ta qiz kere, xonalar 1xona',
    price: 100,
    currency: 'USD',
    roomOnly: false,
  });
  assert.equal(twoWomen.roomOnly, true);
  assert.equal(twoWomen.potentiallyUnsafe, false);

  const risky = enrichListingDetails({
    title: 'Ijaraga 1 xonali kvartira',
    description: "O’zim yashaydigan kvartiraga 1 qiz ijarachi kerak. Faqat qiz bola.",
    price: 80,
    currency: 'USD',
    roomOnly: false,
  });
  assert.equal(risky.roomOnly, true);
  assert.equal(risky.potentiallyUnsafe, true);

  const normalPrice = enrichListingDetails({
    title: 'Подселение',
    description: 'Нужна только одна девушка, одно место в квартире',
    price: 250,
    currency: 'USD',
    roomOnly: true,
  });
  assert.equal(normalPrice.potentiallyUnsafe, false);

  const womenOnlyFlat = enrichListingDetails({
    title: 'Квартира для девушек',
    description: 'Только девушки, сдаётся целая квартира',
    price: 80,
    currency: 'USD',
    roomOnly: false,
  });
  assert.equal(womenOnlyFlat.potentiallyUnsafe, false);
});

test('extracts Uzbek nearby market landmarks into translatable canonical labels', () => {
  const text = 'Sergili moshina bozorga yaqin Turon avto sergili dehqon bozor Ahmad juja 9etajli domni 1etaji';
  assert.deepEqual(detail.parseNearbyLandmarks(text), [
    'Sergili Car Market',
    'Sergili Farmers Market',
    'Turon Avto',
  ]);

  const listing = enrichListingDetails({
    title: 'Квартира',
    description: text,
    nearby: ['Туран'],
  });
  // The shared lexicon's own generic landmark catalog now also contributes a
  // canonical "Market" match alongside this product's own compound
  // "<name> Car/Farmers Market" labels.
  assert.deepEqual(listing.nearby, ['Туран', 'Market', 'Sergili Car Market', 'Sergili Farmers Market', 'Turon Avto']);
});