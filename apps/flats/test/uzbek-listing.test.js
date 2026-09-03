import test from 'node:test';
import assert from 'node:assert/strict';

import { makeListing } from '../src/listing/normalize.js';
import { applyListingFilters } from '../src/legacy/legacy-listing-filter.js';
import { parsePrimaryContact as parseContact } from '@whiteslove/parsing-lexicon/contact';
import { parseHousingPrice as parsePriceFromText } from '@whiteslove/parsing-lexicon/housing-money';
import { parseHousingPayments, parseHousingSeller } from '@whiteslove/parsing-lexicon/housing-structured';
import { parseHousingFloorFromText as parseFloor } from '@whiteslove/parsing-lexicon/housing-text';
import { cityLocations, parseLocation } from '../src/geo/locations.js';
import { resolveTashkentArea } from '../src/geo/tashkent-areas.js';

const description = `Chilonzor 12
Shoxmed sentr
Xavas
2³/4/4
Xamma sharoit bor
Spalni,shkof,gilam, xaladenlik,kirmoshina,kuhinni kansaner bor
Uy yangi remontdan chiqqan.
Oila qo’yiladi.
Inastrans yoki davlat ishida ishlaydigan oila quyiladi
500$ Makler 50%
+998881090509`;

test('parses converted-room Uzbek Telegram shorthand and rental details', () => {
  const listing = makeListing({
    id: 'test',
    source: 'telegram',
    country: 'UZ',
    title: 'Chilonzor 12',
    description,
    price: 500,
    currency: 'USD',
    byAgency: parseHousingSeller(description).type === 'agency',
  });

  assert.equal(listing.propertyType, 'flat');
  assert.equal(listing.rooms, 3);
  assert.equal(listing.floor, 4);
  assert.equal(listing.totalFloors, 4);
  assert.equal(listing.dealType, 'longRent');
  assert.equal(listing.byAgency, true);
  assert.equal(listing.commission, true);
  assert.equal(listing.commissionPercent, 50);
  assert.equal(listing.airConditioner, true);
  assert.equal(listing.furnished, true);
  assert.equal(listing.audience, 'family');
  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Uchtepa');
  assert.equal(listing.kvartal, 'Chilanzar-12');
  assert.equal(listing.metro, null);
  assert.deepEqual(listing.nearbyShops, ['Havas']);
});

const uchtepaDescription = `Uchtepa tumani 25 dahadan 2 xonali uy ijaraga beriladi, rwmont xolati rasmda bor, faqat oilaga beriladi!
2-qavat / 14-qavatli uy.

Atrofida Bobur bog’i, avtobus kanichkasi, poleklinika, maktab va h.k.z`;

test('parses Uchtepa district, daha and floor pair', () => {
  const listing = makeListing({
    id: 'uchtepa-test',
    source: 'telegram',
    country: 'UZ',
    title: 'Uchtepa tumani 25 daha',
    description: uchtepaDescription,
  });

  assert.equal(listing.propertyType, 'flat');
  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, 2);
  assert.equal(listing.totalFloors, 14);
  assert.equal(listing.dealType, 'longRent');
  assert.equal(listing.audience, 'family');
  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Uchtepa');
  assert.equal(listing.kvartal, '25 kvartal');
});

test('parses a bare floor / building-height pair', () => {
  assert.deepEqual(parseFloor('Квартира 2 / 14, рядом с парком'), { floor: 2, totalFloors: 14 });
});

test('parses compact room, floor, area and named orientation from a Telegram post', () => {
  const text = `Сдается квартира

Яккасарайский район "ЖК Kislorod"

Ориентир: Seoul Mun

2/5/16 56кв

Цена: 350$

Пишите / звоните:

771443473 tel`;
  const listing = makeListing({
    id: 'kislorod-test',
    source: 'telegram',
    country: 'UZ',
    title: 'Сдается квартира',
    description: text,
    price: 350,
    currency: 'USD',
  });

  assert.equal(listing.dealType, 'longRent');
  assert.equal(listing.propertyType, 'flat');
  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Yakkasaray');
  assert.equal(listing.residenceComplex, 'Kislorod');
  assert.deepEqual(listing.nearby, ['Seoul Mun']);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, 5);
  assert.equal(listing.totalFloors, 16);
  assert.equal(listing.areaSqm, 56);
  assert.equal(listing.price, 350);
  assert.equal(listing.currency, 'USD');
  assert.equal(listing.contact, '771443473');
  assert.equal(parseContact(text), '771443473');
});

test('parses a basement rental and keeps its labelled base price', () => {
  const text = `🔥 СРОЧНО! АРЕНДА КВАРТИРЫ 🔥

📍 Учтепа Авеню
🏠 2/0/-1 этаж (подвал)
💰 Аренда: 400$
👨‍👩‍👧 Для семьи — 450$
👶 Для семьи с 4 детьми — 400$`;

  const parsedPrice = parsePriceFromText(text, 'UZS');
  const listing = makeListing({
    id: 'uchtepa-basement-test',
    source: 'telegram',
    country: 'UZ',
    title: '🔥 СРОЧНО! АРЕНДА КВАРТИРЫ 🔥',
    description: text,
    price: parsedPrice.amount,
    currency: parsedPrice.currency,
  });

  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, -1);
  assert.equal(listing.totalFloors, null);
  assert.equal(listing.price, 400);
  assert.equal(listing.currency, 'USD');
  assert.equal(listing.dealType, 'longRent');
  assert.equal(listing.district, 'Uchtepa');
});

test('parses hashtag complex, utilities and transit from a Yashnobod post', () => {
  const text = `😉😉😚😉😚
#Яшнабадский
#1комнатная
#ЖКАссаломСохил
Ориентир Узбум

1 комнатная
9 этаж
9 этажный дом

Цена 5 миллионов
Коммунальные услуги отдельно.

Сдается квартира в новостройке,возле центра города.
До метро Ташкент Северный вокзал 5 минут на машине.
Заселяют семейную пару и одиночек мужчину или женщину.

+998903720270 @arenda_tashkent10`;
  const parsedPrice = parsePriceFromText(text, 'UZS');
  const listing = makeListing({
    id: 'yashnobod-assalom-test',
    source: 'telegram',
    country: 'UZ',
    title: '😉😉😚😉😚',
    description: text,
    price: parsedPrice.amount,
    currency: parsedPrice.currency,
  });

  assert.equal(listing.dealType, 'longRent');
  assert.equal(listing.rooms, 1);
  assert.equal(listing.floor, 9);
  assert.equal(listing.totalFloors, 9);
  assert.equal(listing.price, 5_000_000);
  assert.equal(listing.currency, 'UZS');
  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Yashnobod');
  assert.equal(listing.residenceComplex, 'Ассалом Сохил');
  assert.equal(listing.metro, 'Tashkent North Railway Station');
  assert.deepEqual(listing.nearby, ['Узбум']);
  assert.equal(listing.newBuilding, true);
  assert.equal(listing.communalSeparated, true);
  assert.equal(listing.audience, null);
  assert.equal(listing.contact, '+998903720270');
});

test('infers Tashkent from Alay and puts dishwasher into other amenities', () => {
  const text = `#4комнатная #Ц2 #Алайский #Центр

Сдается хорошая, комфортная квартира в центре города. Отличная локация, рядом метро, школы.
Имеется вся техника для жизни, в том числе посудомойка.

Комнаты раздельные.
Цена - 850$ Предоплаты нет, депозит обсуждается на месте.

+998903720270 @arenda_tashkent10`;
  const parsedPrice = parsePriceFromText(text, 'UZS');
  const listing = makeListing({
    id: 'alay-c2-test',
    source: 'telegram',
    country: 'UZ',
    title: '#4комнатная #Ц2 #Алайский #Центр',
    description: text,
    price: parsedPrice.amount,
    currency: parsedPrice.currency,
  });

  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.rooms, 4);
  assert.equal(listing.kvartal, 'Alay');
  assert.equal(listing.price, 850);
  assert.equal(listing.currency, 'USD');
  assert.deepEqual(listing.nearby, ['Alay Bazaar', 'C-2', 'School']);
  assert.deepEqual(listing.amenities, ['Dishwasher', 'Separate rooms']);
});

test('recognizes first-person long rent and all nearby place categories', () => {
  const text = `Сдаю чистую квартиру порядочным людям. В квартире есть все необходимые бытовые техники также рядом есть школа, ТЦ, поликлиника, мечеть и т.д.

Шторы повесим позже

Если не отвечу на звонок пиш

993758330 tel`;
  const listing = makeListing({
    id: 'nearby-categories-test',
    source: 'telegram',
    country: 'UZ',
    title: 'Сдаю чистую квартиру порядочным людям',
    description: text,
  });

  assert.equal(listing.dealType, 'longRent');
  assert.deepEqual(listing.nearby, ['Clinic', 'School', 'Shopping center', 'Mosque']);
  assert.equal(listing.contact, '993758330');
});

test('parses Uzbek Cyrillic rooms, locative floor and implicit monthly rent', () => {
  const text = '2 хонали 3 этажда ремонти яхши холатда турибди 350$';
  const parsedPrice = parsePriceFromText(text, 'UZS');
  const listing = makeListing({
    id: 'uzbek-cyrillic-floor-test',
    source: 'telegram',
    country: 'UZ',
    title: text,
    description: text,
    price: parsedPrice.amount,
    currency: parsedPrice.currency,
  });

  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, 3);
  assert.equal(listing.totalFloors, null);
  assert.equal(listing.price, 350);
  assert.equal(listing.currency, 'USD');
  assert.equal(listing.dealType, 'longRent');
});

test('infers Tashkent from Darkhan and Novomoskovskaya landmarks', () => {
  const text = `#2комнатная #Новомосковская

2 комнатная
1 этаж
2 этажного дом

Сдается 2 комнатная квартира в центре города, ориентир: Дархан, Новомосковская.
Для семьи без детей, можно двум девушкам или маме с детьми!

Цена 450$

+998903720270 @arenda_tashkent10`;
  const parsedPrice = parsePriceFromText(text, 'UZS');
  const listing = makeListing({
    id: 'darkhan-novomoskovskaya-test',
    source: 'telegram',
    country: 'UZ',
    title: '#2комнатная #Новомосковская',
    description: text,
    price: parsedPrice.amount,
    currency: parsedPrice.currency,
  });

  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, 1);
  assert.equal(listing.totalFloors, 2);
  assert.equal(listing.dealType, 'longRent');
  assert.equal(listing.price, 450);
  assert.equal(listing.currency, 'USD');
  assert.deepEqual(listing.nearby, ['Darkhan', 'Novomoskovskaya']);
});

test('does not use a following phone number as the deposit amount', () => {
  const text = `Цена 450$\n\nИмеется договорной депозит.\n\n+998903720270 @arenda_tashkent10`;
  assert.deepEqual(parseHousingPayments(text).deposit, { required: true, kind: 'deposit', amount: null, currency: null });
  assert.deepEqual(parseHousingPayments('Залог 500$; телефон +998 90 123 45 67').deposit, { required: true, kind: 'deposit', amount: 500, currency: 'USD' });
  assert.deepEqual(parseHousingPayments('Депозит 1 500 000 UZS').deposit, { required: true, kind: 'deposit', amount: 1_500_000, currency: 'UZS' });
});

test('finds one shared listing by exact id outside normal pagination', () => {
  const rows = [
    { id: 'first', source: 'telegram', commercial: false },
    { id: 'shared-row', source: 'telegram', commercial: false },
  ];
  assert.deepEqual(
    applyListingFilters(rows, { listingId: 'shared-row', sources: ['telegram'] }).map(({ id }) => id),
    ['shared-row'],
  );
});

test('parses a daily Chilanzar listing with explicit Uzbek sum and amenities', () => {
  const text = `KUNLIK IJARA ✅
Manzil: Chilonzor tumani, 12-kvartal
Mo'ljal: Farhod bozori ro‘parasi, Chilonzor metro 10 minut yo'l
Wi-Fi
Kir yuvish mashinasi
Konditsioner
Televizor
Toza choyshab va yostiq jildlari
Yuz va vanna sochiqlari
Kunlik narx: 200 000 so‘mdan – 250 000 so‘mgacha`;
  const parsedPrice = parsePriceFromText(text, 'UZS');
  const listing = makeListing({
    id: 'daily-chilanzar-test', source: 'telegram', country: 'UZ', title: 'KUNLIK IJARA',
    description: text, price: parsedPrice.amount, currency: parsedPrice.currency,
  });

  assert.equal(listing.price, 200_000);
  assert.equal(listing.currency, 'UZS');
  assert.equal(listing.dealType, 'shortRent');
  assert.equal(listing.district, 'Chilanzar');
  assert.equal(listing.kvartal, 'Chilanzar-12');
  assert.equal(listing.metro, 'Chilonzor');
  assert.deepEqual(listing.nearby, ['Farhod Bazaar']);
  assert.equal(listing.internet, true);
  assert.equal(listing.airConditioner, true);
  assert.deepEqual(listing.amenities, ['Washing machine', 'Television', 'Bed linen', 'Towels']);
});

test('parses an Uzbek roommate listing as a long-term women-only room', () => {
  const text = `Uch tepa 12-kvartalda 1 ta qiz sherikka olinadi.
Nizomiy yoki Jahon tillar universitetida o‘qiydigan qizla.
Inyazga piyodalik yo‘l.`;
  const listing = makeListing({
    id: 'uchtepa-roommate-test', source: 'telegram', country: 'UZ', title: 'Sherikka qiz olinadi', description: text,
  });

  assert.equal(listing.dealType, 'longRent');
  assert.equal(listing.roomOnly, true);
  assert.equal(listing.audience, 'women');
  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Uchtepa');
  assert.equal(listing.kvartal, '12 kvartal');
  assert.deepEqual(listing.nearby, ['Nizami Pedagogical University', 'World Languages University']);
});

test('parses Cyrillic Uzbek shared rent, included utilities and local price', () => {
  const text = `УГИЛ БОЛЛАРГА
КВАРТИРА БОР ХАЗАЙКАЛИ
Сергели
ЯНГИ ЧОШТЕПА
1 метро бекати яқин
1.000.000 дан
Комуналкаси ичида
1 ТА БОЛА КЕРАК.
1 хонага обше 3 киши турилади
Ижара шартнома йук
Без Маклер`;
  const parsedPrice = parsePriceFromText(text, 'UZS');
  const listing = makeListing({
    id: 'sergeli-shared-test', source: 'telegram', country: 'UZ', title: 'КВАРТИРА БОР ХАЗАЙКАЛИ',
    description: text, price: parsedPrice.amount, currency: parsedPrice.currency, byAgency: parseHousingSeller(text).type === 'agency',
  });

  assert.equal(listing.price, 1_000_000);
  assert.equal(listing.currency, 'UZS');
  assert.equal(listing.dealType, 'longRent');
  assert.equal(listing.roomOnly, true);
  assert.equal(listing.audience, 'men');
  assert.equal(listing.byAgency, false);
  assert.equal(listing.communalSeparated, false);
  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Yangihayot');
  assert.equal(listing.kvartal, 'Yangi Choshtepa');
  assert.deepEqual(listing.nearby, ['Yangi Choshtepa']);
});

test('parses Sergeli hudud, realtor shorthand and bare daily UZS', () => {
  const commissionText = `Сергели 10 худуд
Новостройка
Комнат 2
Этаж 6
Этажность 9
400$
Оила
Кизла
Калит узимда
М50%`;
  const commissionPrice = parsePriceFromText(commissionText, 'UZS');
  const listing = makeListing({
    id: 'sergeli-commission-test', source: 'telegram', country: 'UZ', title: 'Сергели 10 худуд',
    description: commissionText, price: commissionPrice.amount, currency: commissionPrice.currency,
    byAgency: parseHousingSeller(commissionText).type === 'agency',
  });
  assert.equal(listing.kvartal, 'Sergeli-10');
  assert.equal(listing.areaAmbiguous, true);
  assert.equal(listing.requireExactAddress, true);
  assert.equal(listing.commission, true);
  assert.equal(listing.commissionPercent, 50);
  assert.equal(listing.byAgency, true);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.floor, 6);
  assert.equal(listing.totalFloors, 9);
  assert.equal(listing.newBuilding, true);

  const dailyText = `Kunlik kvartira xona beriladi
Sergele tumani 5 chi hududda sergele metroda 5 minut metroga piyoda
2 xona navastroyka xazaykalik
Narxi 200 000 kunlik`;
  const dailyPrice = parsePriceFromText(dailyText, 'UZS');
  const daily = makeListing({
    id: 'sergeli-daily-test', source: 'telegram', country: 'UZ', title: 'Kunlik kvartira',
    description: dailyText, price: dailyPrice.amount, currency: dailyPrice.currency,
  });
  assert.equal(daily.price, 200_000);
  assert.equal(daily.currency, 'UZS');
  assert.equal(daily.dealType, 'shortRent');
  assert.equal(daily.kvartal, 'Sergeli-5');
  assert.equal(daily.district, 'Sergeli');
  assert.equal(daily.metro, 'Sergeli');
  assert.equal(daily.roomOnly, true);
  assert.equal(daily.newBuilding, true);
});

test('parses the channel-specific 2 / 2 / 3 shorthand as three rooms on floor two of three', () => {
  const text = `ARENDA
SERGILE MOSHENA BOZOR
2 / 2 / 3. Navastiroyka
Xamma sharoiti bor
Oyla qizlar bollar
Narxi 400$
Makler 50%`;
  const parsedPrice = parsePriceFromText(text, 'UZS');
  const listing = makeListing({
    id: 'sergeli-compact-test', source: 'telegram', country: 'UZ', title: 'ARENDA',
    description: text, price: parsedPrice.amount, currency: parsedPrice.currency,
    byAgency: parseHousingSeller(text).type === 'agency',
  });

  assert.equal(listing.rooms, 3);
  assert.equal(listing.floor, 2);
  assert.equal(listing.totalFloors, 3);
  assert.equal(listing.price, 400);
  assert.equal(listing.currency, 'USD');
  assert.equal(listing.commissionPercent, 50);
  assert.equal(listing.newBuilding, true);
  assert.equal(listing.district, 'Sergeli');
  assert.deepEqual(listing.nearby, ['Sergeli Car Bazaar']);
});

test('parses separate floor and building-height labels from a Yunusabad rental', () => {
  const text = `Аренда:
- Юнусабад-2 квартал.
- 2 комнатная, 3 этаж, 5 этажный дом, новый ремонт, мебель и техника, интернет, цена: 650$`;
  const listing = makeListing({
    id: 'yunusabad-floor-test', source: 'telegram', country: 'UZ', title: 'Аренда', description: text,
  });
  assert.equal(listing.floor, 3);
  assert.equal(listing.totalFloors, 5);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.kvartal, 'Yunusabad-2');
  assert.equal(listing.district, 'Yunusabad');
});

test('parses Glinka as a named Yakkasaray microdistrict', () => {
  const listing = makeListing({
    id: 'yakkasaray-glinka-test',
    source: 'telegram',
    country: 'UZ',
    title: 'Яккасарайский район, Глинка.',
    description: 'Яккасарайский район, Глинка.',
  });

  assert.equal(listing.city, 'Tashkent');
  assert.equal(listing.district, 'Yakkasaray');
  assert.equal(listing.area, 'Glinka');
  assert.equal(listing.kvartal, 'Glinka');
});

test('exposes all twelve Tashkent administrative districts', () => {
  assert.deepEqual(
    new Set(cityLocations('UZ').Tashkent.districts),
    new Set([
      'Almazar', 'Bektemir', 'Mirobod', 'Mirzo Ulugbek', 'Sergeli', 'Uchtepa',
      'Chilanzar', 'Shaykhantahur', 'Yunusabad', 'Yakkasaray', 'Yangihayot', 'Yashnobod',
    ]),
  );
});

test('maps numbered Chilanzar areas to their actual districts', () => {
  assert.deepEqual(resolveTashkentArea('Чиланзар-7'), {
    area: 'Chilanzar-7', district: 'Chilanzar', confidence: 1, ambiguous: false, requireExactAddress: false,
  });
  assert.deepEqual(resolveTashkentArea('13 квартал Чиланзара'), {
    area: 'Chilanzar-13', district: 'Uchtepa', confidence: 1, ambiguous: false, requireExactAddress: false,
  });
  assert.equal(parseLocation('Chilonzor 23 kvartal', 'UZ').district, 'Uchtepa');
});

test('resolves Kuylyuk ranges and preserves a bare ambiguous area', () => {
  assert.equal(resolveTashkentArea('Куйлюк-2').district, 'Mirobod');
  assert.equal(resolveTashkentArea('Куйлюк 6 квартал').district, 'Sergeli');
  assert.equal(resolveTashkentArea('Куйлюк-Центр').district, 'Yashnobod');
  assert.deepEqual(resolveTashkentArea('Ориентир рынок Куйлюк'), {
    area: 'Kuylyuk', district: null, confidence: 0.25, ambiguous: true, requireExactAddress: true,
  });
});

test('resolves Sergeli legacy addresses without guessing a bare massif', () => {
  assert.equal(resolveTashkentArea('Сергели-1').district, 'Yangihayot');
  assert.equal(resolveTashkentArea('Сергели-5А').district, 'Yangihayot');
  assert.equal(resolveTashkentArea('Сергели-6А').district, 'Sergeli');
  assert.deepEqual(resolveTashkentArea('Сергели, квартира рядом с рынком'), {
    area: 'Sergeli', district: null, confidence: 0.35, ambiguous: true, requireExactAddress: true,
  });
  assert.equal(parseLocation('Sergele tumani, kvartira ijaraga', 'UZ').district, 'Sergeli');
});

test('maps legacy C-codes and named massifs to current districts', () => {
  assert.equal(resolveTashkentArea('Лабзак Ц-13').district, 'Shaykhantahur');
  assert.equal(resolveTashkentArea('Кашгар Ц-4').district, 'Yunusabad');
  assert.equal(resolveTashkentArea('Алайский Ц-2').district, 'Mirzo Ulugbek');
  assert.equal(resolveTashkentArea('Авиасозлар-3').district, 'Yashnobod');
  assert.equal(resolveTashkentArea('Янги Чоштепа').district, 'Yangihayot');
  assert.equal(resolveTashkentArea('Глинка').district, 'Yakkasaray');
});
