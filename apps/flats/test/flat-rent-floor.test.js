import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichListingDetails } from '../src/listing/listing-enrichment.js';

const flat = (extra) => enrichListingDetails({ country: 'UZ', propertyType: 'flat', dealType: 'longRent', title: 'Квартира', description: 'Сдаётся квартира', ...extra });

test('a Uzbek or Kyrgyz long-rent "flat" priced like a bed is a room rental', () => {
  assert.equal(flat({ price: 800_000, currency: 'UZS' }).roomOnly, true);
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
