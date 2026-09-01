import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/countries.js';
import { ownerHousingSources } from '../src/owner-housing-sources.js';
import { realtorHousingSources } from '../src/realtor-housing-sources.js';
import { telegramHousingChannels } from '../src/telegram-housing-sources.js';
import { buildCrawlPlan } from '../src/queuePlan.js';
import { enforceOwnerOnlyListings } from '../src/queueTasks.js';

test('owner registry covers curated direct-owner platforms in every configured country', () => {
  const urls = Object.keys(COUNTRIES).flatMap((country) => ownerHousingSources(country).map((source) => source.url));
  for (const expected of [
    'https://rentli.uz/en/listings',
    'https://ostona.app/en',
    'https://turar.uz/ru/tashkent',
    'https://easy-house.in.ua/search/',
    'https://kvarto.app/uk',
    'https://www.norieltor.com.ua/',
    'https://dom.ria.com/uk/arenda-kvartir/bez-rieltora/',
    'https://bezmakler.com.ua/',
    'https://dobalux.com/uk/',
    'https://krisha.kz/arenda/kvartiry/kazakhstan/?das%5Bwho%5D=1',
    'https://krisha.kz/arenda/kvartiry-posutochno/kazakhstan/?das%5Bwho%5D=1',
    'https://www.kn.kz/almaty/arenda-kvartir-bez-posrednikov-s-foto',
    'https://www.kn.kz/almaty/arenda-kvartir-posutochno-bez-posrednikov',
    'https://www.kn.kz/astana/arenda-kvartir-bez-posrednikov',
    'https://www.kn.kz/astana/arenda-kvartir-posutochno-bez-posrednikov',
    'https://www.kn.kz/karaganda/arenda-kvartir-bez-posrednikov',
    'https://www.kn.kz/karaganda/arenda-kvartir-posutochno-bez-posrednikov',
    'https://www.kn.kz/aktobe/arenda-kvartir-bez-posrednikov',
    'https://www.kn.kz/atyrau/arenda-kvartir-bez-posrednikov',
    'https://www.kn.kz/uralsk/arenda-kvartir-bez-posrednikov',
    'https://www.kn.kz/taraz/arenda-kvartir-bez-posrednikov',
    'https://www.proprietaripebune.ro/chirii/bucuresti',
    'https://proprietar-direct.ro/categorii-anunturi/oferte-de-inchiriat/',
    'https://www.directfaracomision.ro/anunturi?tip_proprietate=apartment&tip_tranzactie=inchiriere',
    'https://garsoniera.ro/anunturi/inchiriere',
    'https://www.publi24.ro/anunturi/imobiliare/de-inchiriat/?commercial=false&q=proprietari',
    'https://arendator.kg/',
    'https://myhouse.kg/rent/apartment/',
    'https://sutochno.kg/bishkek/',
    'https://sutochno.kg/osh/',
  ]) {
    assert.equal(urls.filter((url) => url === expected).length, 1, expected);
  }
  assert.ok(!urls.some((url) => url.includes('delaproprietar.ro')));
  assert.ok(!urls.some((url) => url.includes('rentnbuy.com')));
  assert.equal(ownerHousingSources('UZ').find((source) => source.key === 'turar-tashkent-owner-daily')?.dealType, 'shortRent');
  assert.equal(ownerHousingSources('UA').find((source) => source.key === 'dobalux-ukraine-owner-daily')?.dealType, 'shortRent');
  assert.equal(ownerHousingSources('KZ').find((source) => source.key === 'krisha-kazakhstan-owner-daily')?.dealType, 'shortRent');
  assert.equal(ownerHousingSources('KZ').find((source) => source.key === 'kn-almaty-owner-daily')?.dealType, 'shortRent');
  assert.equal(ownerHousingSources('KG').find((source) => source.key === 'sutochno-bishkek-owner-daily')?.dealType, 'shortRent');
  assert.equal(ownerHousingSources('KG').find((source) => source.key === 'sutochno-osh-owner-daily')?.city, 'Osh');
  assert.ok(ownerHousingSources('KG').find((source) => source.key === 'myhouse-kyrgyzstan-owner-rent')?.ownerMarkers?.includes('собственник'));
  assert.ok(ownerHousingSources('KZ').find((source) => source.key === 'krisha-kazakhstan-owner-rent')?.ownerMarkers?.includes('хозяин недвижимости'));
  assert.ok(ownerHousingSources('RO').find((source) => source.key === 'publi24-romania-owner-rent')?.ownerMarkers?.includes('proprietar'));
  assert.ok(!realtorHousingSources('UZ').some((source) => source.url.includes('rentli.uz')));
  assert.equal(COUNTRIES.KG?.currency, 'KGS');
  assert.deepEqual(COUNTRIES.KG?.sources, ['telegram']);
  assert.ok(COUNTRIES.KG?.crawlCities.includes('Osh'));
  assert.ok(COUNTRIES.KZ?.crawlCities.includes('Taraz'));
});

test('dedicated owner Telegram feeds coexist with mixed inventory', () => {
  const uz = telegramHousingChannels('UZ', COUNTRIES.UZ.telegramChannels);
  assert.ok(uz.some((channel) => channel === 'arentash'));
  assert.ok(!uz.some((channel) => channel?.name === 'arentash' && channel.ownerOnly === true));
  assert.equal(uz.find((channel) => channel?.name === 'ijaraga_kvartiralar_Bezmakler')?.ownerOnly, true);
  const extraBezMakler = uz.find((channel) => channel?.name === 'bezmakler_ijara');
  assert.equal(extraBezMakler?.ownerOnly, true);
  assert.ok(extraBezMakler?.ownerMarkers.includes('egasi'));
  const maklersiz = uz.find((channel) => channel?.name === 'Maklersiz');
  assert.equal(maklersiz?.ownerOnly, true);
  assert.ok(maklersiz?.ownerMarkers.includes('без маклер'));
  const bezMakler = uz.find((channel) => channel?.name === 'bez_makler');
  assert.equal(bezMakler?.ownerOnly, true);
  assert.ok(bezMakler?.ownerMarkers.includes('bezmakler'));

  const kz = telegramHousingChannels('KZ', COUNTRIES.KZ.telegramChannels);
  assert.equal(kz.find((channel) => channel?.name === 'kvartiry2')?.ownerOnly, true);
  assert.equal(kz.find((channel) => channel?.name === 'freehomekz_Almaty')?.dealType, 'shortRent');
  const almatyMixed = kz.find((channel) => channel?.name === 'kvartira_v_almaty');
  assert.notEqual(almatyMixed?.ownerOnly, true);
  assert.equal(almatyMixed?.dealType, 'longRent');
  assert.equal(kz.find((channel) => channel?.name === 'arenda_kvartiry_astana')?.ownerOnly, true);
  assert.notEqual(kz.find((channel) => channel?.name === 'rentinastana')?.ownerOnly, true);

  const ua = telegramHousingChannels('UA', COUNTRIES.UA.telegramChannels);
  assert.equal(ua.find((channel) => channel?.name === 'kievrentfree')?.ownerOnly, true);
  assert.equal(ua.find((channel) => channel?.name === 'orenda_bez_rieltora')?.ownerOnly, true);
  assert.equal(ua.find((channel) => channel?.name === 'orenda_kyiv_city')?.ownerOnly, true);
  assert.equal(ua.find((channel) => channel?.name === 'arendakyiv_ua')?.ownerOnly, true);
  assert.notEqual(ua.find((channel) => channel?.name === 'rent_frankivsk')?.ownerOnly, true);
  assert.notEqual(ua.find((channel) => channel?.name === 'SMARTIN_MYKOLAYIV')?.ownerOnly, true);
  assert.notEqual(ua.find((channel) => channel?.name === 'rentin_khmelnytskyi')?.ownerOnly, true);

  const kg = telegramHousingChannels('KG', COUNTRIES.KG.telegramChannels);
  const bishkek = kg.find((channel) => channel?.name === 'bishkekarendakv');
  assert.notEqual(bishkek?.ownerOnly, true);
  assert.equal(bishkek?.dealType, 'longRent');
});

test('crawl plan restores daily OLX and queues owner-first sources', () => {
  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  for (const country of ['UZ', 'KZ', 'UA', 'RO']) {
    assert.ok(tasks.some((task) => task.type === 'flat.olx.page' && task.country === country && task.segment === 'flat:shortRent'));
  }
  const roLongRent = tasks.find((task) => task.type === 'flat.olx.page' && task.country === 'RO' && task.segment === 'flat:longRent');
  assert.notEqual(roLongRent?.ownerOnly, true);
  for (const segment of [
    'rentli-tashkent-owner-rent',
    'turar-tashkent-owner-daily',
    'easyhouse-ukraine-owner-rent',
    'kvarto-ukraine-owner-rent',
    'norieltor-ukraine-owner-rent',
    'dimria-ukraine-owner-rent',
    'bezmakler-odesa-owner-rent',
    'dobalux-ukraine-owner-daily',
    'krisha-kazakhstan-owner-rent',
    'krisha-kazakhstan-owner-daily',
    'kn-almaty-owner-rent',
    'kn-almaty-owner-daily',
    'kn-astana-owner-rent',
    'kn-astana-owner-daily',
    'kn-karaganda-owner-rent',
    'kn-karaganda-owner-daily',
    'kn-aktobe-owner-rent',
    'kn-atyrau-owner-rent',
    'kn-oral-owner-rent',
    'kn-taraz-owner-rent',
    'proprietari-pe-bune-bucharest-owner-rent',
    'proprietar-direct-romania-owner-rent',
    'direct-fara-comision-romania-owner-rent',
    'garsoniera-romania-owner-rent',
    'publi24-romania-owner-rent',
    'arendator-bishkek-owner-rent',
    'myhouse-kyrgyzstan-owner-rent',
    'sutochno-bishkek-owner-daily',
    'sutochno-osh-owner-daily',
  ]) {
    assert.ok(tasks.some((task) => task.type === 'flat.custom.url' && task.segment === segment && task.ownerOnly));
  }
  const myHouse = tasks.find((task) => task.type === 'flat.custom.url' && task.segment === 'myhouse-kyrgyzstan-owner-rent');
  assert.ok(myHouse?.ownerMarkers.includes('собственник'));
  const krisha = tasks.find((task) => task.type === 'flat.custom.url' && task.segment === 'krisha-kazakhstan-owner-rent');
  assert.ok(krisha?.ownerMarkers.includes('хозяин недвижимости'));
  const publi24 = tasks.find((task) => task.type === 'flat.custom.url' && task.segment === 'publi24-romania-owner-rent');
  assert.ok(publi24?.ownerMarkers.includes('proprietar'));
  assert.ok(tasks.some((task) =>
    task.type === 'flat.telegram.channel'
    && task.country === 'KG'
    && task.channel === 'bishkekarendakv'
    && task.ownerOnly !== true,
  ));
});

test('owner policy rejects realtor-marked inventory', () => {
  const listings = [
    { title: 'Сдаю квартиру', description: 'Ташкент 2 комнаты 500$ #хозяева', byAgency: false },
    { title: 'Сдаю квартиру', description: 'Ташкент 2 комнаты 500$ #риелтор', byAgency: false },
    { title: 'Сдам квартиру', description: 'Комиссия риелтора 50%, Ташкент', byAgency: true },
  ];
  const filtered = enforceOwnerOnlyListings(listings, {
    ownerOnly: true,
    ownerMarkers: ['#хозяева'],
    ownerRejectMarkers: ['#риелтор'],
    dealType: 'longRent',
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].byAgency, false);
  assert.equal(filtered[0].commission, false);
  assert.equal(filtered[0].commissionPercent, 0);
  assert.equal(filtered[0].dealType, 'longRent');
});

test('mixed custom catalog requires an explicit owner marker', () => {
  const listings = [
    { title: '2 комнаты, Собственник', description: 'Бишкек 50 000 сом', byAgency: false },
    { title: '2 комнаты', description: 'Бишкек 50 000 сом', byAgency: false },
    { title: '2 комнаты', description: 'Агентство недвижимости, Бишкек', byAgency: true },
  ];
  const filtered = enforceOwnerOnlyListings(listings, {
    ownerOnly: true,
    ownerMarkers: ['собственник', 'частное лицо'],
    dealType: 'longRent',
  });
  assert.equal(filtered.length, 1);
  assert.match(filtered[0].title, /Собственник/);
});
