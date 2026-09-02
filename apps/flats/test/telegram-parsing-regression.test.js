import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTelegramAgency,
  guessTelegramPropertyType,
  parseTelegramPrice,
  splitTelegramHousingMessage,
  telegramMessageToListings,
} from '../src/scrapers/telegram.js';

const UZ = {code: 'UZ', currency: 'UZS'};

const problematicPost = `Шайхонтохур 500 Samarqand darvozad shayxon toxur tumani Xovlini yarimi 3 xona Metroga 5 minut avtoda Bezmakler variant murojaat uchun:
🏡 Eng yaxshi variantlar siz uchun tayyor! Faqat tanlang — qolganini biz osonlashtiramiz 😉
❌ Maklersiz ✅ Tez va qulay xizmat 📲 Admin:@Toshkent_maklerszuy`;

const digestPost = `🏙 ENG SO'NGGI FAOL E'LONLAR 🔥
🔥 Eng so'nggi, tekshirilgan e'lonlar — tez va ishonchli xizmat!
━━━━━━━━━━━━
📍 #Yunusobod (davomi)
67. 🔑 №1438 · #Yunusobod (14-kvartal)
🚪 2/8/9 · 💰 450 $ · 👥 Oila, Qizlar
📞 +998776899997

68. 🔑 №1407 · #Yunusobod (—19 kvartil)
🚪 3/3/5 · 💰 500 $ · 👥 Oila
📞 +998776899997

69. 🔑 №1398 · #Yunusobod (— Shahrenston choraxa)
🚪 2/3/4 · 💰 500 $ · 👥 Oila
📞 +998776899997

70. 🔑 №1325 · #Yunusobod (Юнусобод 5-мавзеда)
🚪 2/2/5 · 💰 500 $ · 👥 Oila, Qizlar
📞 +998776899997

📍 #Uchtepa
73. 🔑 №1636 · #Uchtepa (— shirin kucha)
🚪 2/2/4 · 💰 350 $ · 👥 Oila
📞 +998776899997

━━━━━━━━━━━━
💼 Makler haqqi: 33% — Eng sifatli xizmat uchun, eng kam komissiya!
👩‍💼 Dilafruz
📞 +998776899997
💬 @dilafruz_9997
📢 Obuna bo'ling`;

test('parses bare USD price from Uzbek Telegram rental without dealType metadata', () => {
  assert.deepEqual(parseTelegramPrice(problematicPost, UZ), { amount: 500, currency: 'USD', approximate: false });
});

test('direct-owner wording overrides makler text in Telegram promo footer', () => {
  assert.equal(classifyTelegramAgency(problematicPost), false);
});

test('xovlini yarimi is treated as a house, not a flat', () => {
  assert.equal(guessTelegramPropertyType(problematicPost), 'house');
});

test('bare-price fallback ignores area/block numbers and explicit sale posts', () => {
  assert.deepEqual(parseTelegramPrice('Yunusobod 500 m2 hovli sotiladi', UZ), { amount: null, currency: 'UZS', approximate: false });
  assert.deepEqual(parseTelegramPrice('Chilonzor 500 kvartal 3 xona', UZ), { amount: null, currency: 'UZS', approximate: false });
  assert.deepEqual(parseTelegramPrice('Shayxontohur 500 Samarqand Darvoza hovli sotiladi', UZ), { amount: null, currency: 'UZS', approximate: false });
});

test('splits numbered Uzbek Telegram apartment digests without leaking adjacent flats', () => {
  const parts = splitTelegramHousingMessage(digestPost);
  assert.equal(parts.length, 5);
  assert.match(parts[2].text, /69\. 🔑 №1398/u);
  assert.match(parts[2].text, /🚪 2\/3\/4/u);
  assert.match(parts[2].text, /💰 500 \$/u);
  assert.match(parts[2].text, /Makler haqqi: 33%/u);
  assert.match(parts[2].text, /@dilafruz_9997/u);
  assert.doesNotMatch(parts[2].text, /№1438|№1325/u);
  assert.doesNotMatch(parts[3].text, /#Uchtepa/u);
  assert.match(parts[4].text, /#Uchtepa/u);
});

test('creates one stable listing per digest apartment while preserving the original Telegram URL', () => {
  const listings = telegramMessageToListings(
    {id: 2761635, date: '2026-09-01T10:00:00.000Z', text: digestPost},
    {name: 'TOSHKENT_IJARAGA_UYLAR_SERGELI', city: 'Tashkent', dealType: 'longRent'},
    UZ,
  );

  assert.equal(listings.length, 5);
  const target = listings.find((listing) => listing.title.includes('№1398'));
  assert.ok(target);
  assert.equal(target.price, 500);
  assert.equal(target.currency, 'USD');
  assert.equal(target.url, 'https://t.me/TOSHKENT_IJARAGA_UYLAR_SERGELI/2761635');
  assert.match(target.id, /listing-1398-69$/u);
  assert.match(target.description, /Shahrenston choraxa/u);
  assert.doesNotMatch(target.description, /№1438|№1325/u);
  assert.equal(new Set(listings.map((listing) => listing.id)).size, listings.length);
});

test('keeps ordinary single-listing Telegram posts unsplit', () => {
  assert.deepEqual(splitTelegramHousingMessage(problematicPost), [{text: problematicPost, suffix: null}]);
});
