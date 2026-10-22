import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichListingDetails } from '../src/listing/listing-enrichment.js';

const flat = (extra) => enrichListingDetails({ country: 'UZ', propertyType: 'flat', dealType: 'longRent', title: 'Квартира', description: 'Сдаётся квартира', ...extra });

test('a Uzbek or Kyrgyz long-rent "flat" priced like a bed is a room rental', () => {
  assert.equal(flat({ price: 800_000, currency: 'UZS' }).roomOnly, true);
  assert.equal(flat({ price: 1_000_000, currency: 'UZS' }).roomOnly, true);
  assert.equal(flat({ price: 100, currency: 'USD' }).roomOnly, true);
  assert.equal(flat({ price: 450_000, currency: 'UZS' }).roomOnly, true);
  assert.equal(flat({ price: 60, currency: 'USD' }).roomOnly, true);
  assert.equal(flat({ country: 'KG', price: 3_000, currency: 'KGS' }).roomOnly, true);
});

test('real flat prices, sales and short stays are untouched', () => {
  assert.equal(flat({ price: 650, currency: 'USD' }).roomOnly, false);
  assert.equal(flat({ price: 4_500_000, currency: 'UZS' }).roomOnly, false);
  assert.equal(flat({ price: 40, currency: 'USD', dealType: 'shortRent' }).roomOnly, false);
  assert.equal(flat({ price: 40, currency: 'USD', dealType: 'sale' }).roomOnly, false);
  assert.equal(flat({ price: null, currency: 'USD' }).roomOnly, false);
});

test('countries whose sources mislabel hard currency are never classified by price', () => {
  assert.equal(flat({ country: 'UA', price: 150, currency: 'UAH' }).roomOnly, false);
  assert.equal(flat({ country: 'UA', price: 3_000, currency: 'UAH' }).roomOnly, false);
  assert.equal(flat({ country: 'RO', price: 50, currency: 'EUR' }).roomOnly, false);
  assert.equal(flat({ country: 'KZ', price: 30_000, currency: 'KZT' }).roomOnly, false);
  // A currency label that does not belong to the country is not trusted either.
  assert.equal(flat({ country: 'UZ', price: 1_400, currency: 'KZT' }).roomOnly, false);
});

test('a flat offered to one group only is a shared stay up to the audience price cap', () => {
  const women = { description: 'Сдаётся 2-комнатная квартира, только женщинам, без животных' };
  assert.equal(flat({ ...women, price: 2_000_000, currency: 'UZS' }).roomOnly, true);
  assert.equal(flat({ ...women, price: 200, currency: 'USD' }).roomOnly, true);
  assert.equal(flat({ description: 'Talabalar uchun kvartira ijaraga', price: 2_500_000, currency: 'UZS' }).roomOnly, true);
  // Above the cap the same wording is a whole flat for that group; a family flat is never shared by audience.
  assert.equal(flat({ ...women, price: 4_000_000, currency: 'UZS' }).roomOnly, false);
  assert.equal(flat({ description: 'Сдам квартиру семье на долгий срок', price: 2_000_000, currency: 'UZS' }).roomOnly, false);
  assert.equal(flat({ ...women, country: 'UA', price: 2_000, currency: 'UAH' }).roomOnly, false);
});

test('weak shared-stay wording only counts together with a low price', () => {
  const dorm = { description: 'Kvartira bor 1 kishiga, yotoqxona' };
  assert.equal(flat({ ...dorm, price: 1_500_000, currency: 'UZS' }).roomOnly, true);
  assert.equal(flat({ ...dorm, price: 2_400_000, currency: 'UZS' }).roomOnly, false);
  // "yotoqxona" is a bedroom in a plain family flat, and "bollarga" appears in ordinary ads.
  assert.equal(flat({ description: 'Oilaga 3 xonali kvartira, 2 ta yotoqxona, bollarga qulay', price: 6_000_000, currency: 'UZS' }).roomOnly, false);
  assert.equal(flat({ description: 'Sergeli 2 xonali kvartira, yotoqxona 12 m2', price: 3_500_000, currency: 'UZS' }).roomOnly, false);
  assert.equal(flat({ description: 'Сдаётся 1 комнатная квартира, бывшее общежитие, метро рядом', price: 3_500_000, currency: 'UZS' }).roomOnly, false);
});
