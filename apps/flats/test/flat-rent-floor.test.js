import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichListingDetails } from '../src/listing/listing-enrichment.js';

const flat = (extra) => enrichListingDetails({ country: 'UZ', propertyType: 'flat', dealType: 'longRent', title: 'Квартира', description: 'Сдаётся квартира', ...extra });

test('a long-rent "flat" priced like a bed is a room rental', () => {
  assert.equal(flat({ price: 800_000, currency: 'UZS' }).roomOnly, true);
  assert.equal(flat({ price: 450_000, currency: 'UZS' }).roomOnly, true);
  assert.equal(flat({ price: 60, currency: 'USD' }).roomOnly, true);
});

test('real flat prices, sales and short stays are untouched', () => {
  assert.equal(flat({ price: 650, currency: 'USD' }).roomOnly, false);
  assert.equal(flat({ price: 4_500_000, currency: 'UZS' }).roomOnly, false);
  assert.equal(flat({ price: 40, currency: 'USD', dealType: 'shortRent' }).roomOnly, false);
  assert.equal(flat({ price: 40, currency: 'USD', dealType: 'sale' }).roomOnly, false);
  assert.equal(flat({ price: null, currency: 'USD' }).roomOnly, false);
});
