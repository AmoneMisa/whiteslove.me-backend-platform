import test from 'node:test';
import assert from 'node:assert/strict';
import { makeListing } from '../src/listing/normalize.js';

const card = 'Premium Продажа квартира 3-комнатная Яшнабадский район. ID L0013 Ташкент 75 м² 11/16 Состояние: евро ремонт $125 000 в месяц';

test('a sale card with a sale-sized price inside a rent-scoped catalogue is a sale', () => {
  const listing = makeListing({ country: 'UZ', source: 'custom', title: '3-комнатная квартира', description: card, price: 125_000, currency: 'USD', dealType: 'longRent' });
  assert.equal(listing.dealType, 'sale');
});

test('rent copy that mentions "Продажа" with a rent-sized price stays a rent', () => {
  const listing = makeListing({ country: 'UZ', source: 'custom', title: 'Квартира', description: 'Аренда 2-комнатная. Продажа мебели отдельно. $500 в месяц', price: 500, currency: 'USD', dealType: 'longRent' });
  assert.equal(listing.dealType, 'longRent');
});
