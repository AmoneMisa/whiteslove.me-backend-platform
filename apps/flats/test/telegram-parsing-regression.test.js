import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTelegramAgency,
  guessTelegramPropertyType,
  parseTelegramPrice,
} from '../src/scrapers/telegram.js';

const UZ = {code: 'UZ', currency: 'UZS'};

const problematicPost = `Шайхонтохур 500 Samarqand darvozad shayxon toxur tumani Xovlini yarimi 3 xona Metroga 5 minut avtoda Bezmakler variant murojaat uchun:
🏡 Eng yaxshi variantlar siz uchun tayyor! Faqat tanlang — qolganini biz osonlashtiramiz 😉
❌ Maklersiz ✅ Tez va qulay xizmat 📲 Admin:@Toshkent_maklerszuy`;

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
