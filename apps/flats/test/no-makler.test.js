import test from 'node:test';
import assert from 'node:assert/strict';

import { makeListing } from '../src/normalize.js';
import { classifyAgency } from '../src/textparse.js';
import { parseCommission } from '../src/textparse-overrides.js';

const text = `Квартира ЖК NRG BAXT БЕЗ МАКЛЕР!\n\nСдается квартира порядочным людям и иностранцам со всеми удобствами.`;

test('no-makler listing has no commission and clean residential-complex name', () => {
  const listing = makeListing({
    id: 'nrg-baxt-no-makler',
    source: 'olx',
    country: 'UZ',
    title: 'Квартира ЖК NRG BAXT',
    description: 'БЕЗ МАКЛЕР!\nСдается квартира порядочным людям и иностранцам со всеми удобствами.',
    byAgency: classifyAgency(text),
  });

  assert.equal(listing.byAgency, false);
  assert.equal(listing.commission, false);
  assert.equal(listing.commissionPercent, 0);
  assert.equal(listing.residenceComplex, 'NRG BAXT');
});

test('multilingual no-commission phrases override broker words', () => {
  const samples = [
    'Без риелтора, без комиссии',
    'Без посредников, от собственника',
    'No broker fee, owner direct',
    'Fără comision, direct proprietar',
    'Maklersiz, uy egasidan',
    'Komissiyasiz, vositachisiz',
    'Комиссиясыз, үй иесінен',
    'Делдалсыз',
  ];

  for (const sample of samples) {
    assert.deepEqual(parseCommission(sample), { has: false, percent: 0 }, sample);
  }
});

test('explicit commission percentage is parsed across languages', () => {
  const samples = [
    ['Комиссия 50%', 50],
    ['Комісія 40%', 40],
    ['Рієлтор, 50% комісійних + перший місяць', 50],
    ['Commission 25%', 25],
    ['Comision 30%', 30],
    ['Komissiya 35%', 35],
    ['Makler 50%', 50],
    ['M50%', 50],
    ['Делдал 20%', 20],
  ];

  for (const [sample, percent] of samples) {
    assert.deepEqual(parseCommission(sample), { has: true, percent }, sample);
  }
});

test('Ukrainian family restriction and realtor percentage populate normalized fields', () => {
  const listing = makeListing({
    id: 'ua-family-commission',
    source: 'olx',
    country: 'UA',
    title: 'Оренда квартири',
    description: 'РОЗГЛЯДАЄМО СІМЕЙНУ ПАРУ З ДІТКАМИ ВІД 6-ТИ РОКІВ, БЕЗ ТВАРИН. Рієлтор, 50% комісійних + перший місяць.',
  });

  assert.equal(listing.audience, 'family');
  assert.equal(listing.commission, true);
  assert.equal(listing.commissionPercent, 50);
});

test('broker mention alone does not imply commission', () => {
  const samples = [
    'Показывает риелтор',
    'Makler bilan aloqa',
    'Contact agent for viewing',
    'Agenție imobiliară',
    'Vositachi orqali ko‘rish mumkin',
    'Делдал көрсетеді',
  ];

  for (const sample of samples) {
    assert.deepEqual(parseCommission(sample), { has: null, percent: null }, sample);
  }
});

test('structured Yunusobod listing prefers Xonalari layout and allows both genders', () => {
  const listing = makeListing({
    id: 'yunusobod-2',
    source: 'telegram',
    country: 'UZ',
    title: 'Manzili: Yunusobod 2-kvartal',
    description: `Manzili: Yunusobod 2-kvartal\nMegaplanet, Yunusobod metro yaqinida\nNarxi: 600$ QIZLAR yoki YIGITLAR\n(6/7tagacha)\nXonalari: 2/2/4\nMaydoni: 57 m²`,
  });

  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, 2);
  assert.equal(listing.totalFloors, 4);
  assert.equal(listing.audience, null);
  assert.equal(listing.district, 'Yunusabad');
});

test('explicit Bektemir district outranks Kuylyuk area inference', () => {
  const listing = makeListing({
    id: 'bektemir-kuylyuk',
    source: 'telegram',
    country: 'UZ',
    title: '•Аренда:',
    description: `•Аренда:\n- Бектемирский район, Куйлюк.\n- 2 комнатная, 12 этаж, 15 этажный дом, новостройка, мебель и техника, интернет, цена: 500$`,
  });

  assert.equal(listing.district, 'Bektemir');
  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, 12);
  assert.equal(listing.totalFloors, 15);
});

test('Yakkasaray Residence ЖК stops before area and compact layout tail', () => {
  const listing = makeListing({
    id: 'yakkasaray-residence',
    source: 'telegram',
    country: 'UZ',
    title: 'Сдается квартира Яккасарайский район ЖК Yakkasaray Residence Глинка 3/10/10 90 кв',
    description: 'С мебелью и техникой',
  });

  assert.equal(listing.district, 'Yakkasaray');
  assert.equal(listing.residenceComplex, 'Yakkasaray Residence');
  assert.equal(listing.rooms, 3);
  assert.equal(listing.floor, 10);
  assert.equal(listing.totalFloors, 10);
});

test('Buyuk Ipak Yuli area does not override explicit Mirzo Ulugbek district', () => {
  const listing = makeListing({
    id: 'c1-eco-park',
    source: 'telegram',
    country: 'UZ',
    title: '•Аренда:',
    description: `•Аренда:\n- Ц-1, ЭКО парк.\n- 3 комнатная, 3 этаж, 9 этажный дом, хороший ремонт, мебель и техника, интернет, цена: 1000$`,
    district: 'Mirzo Ulugbek',
  });

  assert.equal(listing.district, 'Mirzo Ulugbek');
  assert.equal(listing.rooms, 3);
  assert.equal(listing.floor, 3);
  assert.equal(listing.totalFloors, 9);
});
