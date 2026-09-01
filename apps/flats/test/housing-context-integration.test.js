import test from 'node:test';
import assert from 'node:assert/strict';
import { makeListing } from '../src/normalize.js';

const base = {
  id: 'ctx-1',
  source: 'telegram',
  country: 'UZ',
  city: 'Tashkent',
  price: null,
  currency: 'USD',
  url: 'https://example.invalid/listing',
};

test('wanted purchase stays sale but is not an offer', () => {
  const listing = makeListing({ ...base, title: 'Куплю 2-комнатную квартиру в Ташкенте' });
  assert.equal(listing.housingAction, 'buy');
  assert.equal(listing.listingKind, 'propertyWanted');
  assert.equal(listing.dealType, 'sale');
});

test('short rent keeps transaction side and duration separate', () => {
  const listing = makeListing({ ...base, id: 'ctx-2', title: 'Сдам квартиру посуточно' });
  assert.equal(listing.housingAction, 'rentOut');
  assert.equal(listing.listingKind, 'propertyOffer');
  assert.equal(listing.dealType, 'shortRent');
});

test('housing context survives normalization as structured fields', () => {
  const listing = makeListing({
    ...base,
    id: 'ctx-3',
    title: 'Сдам квартиру',
    description: 'Новый ремонт. Без животных, с детьми можно. Ипотека возможна. Кадастр готов. Без торга.',
  });
  assert.equal(listing.propertyCondition, 'newRenovation');
  assert.equal(listing.tenantPolicies.pets, 'notAllowed');
  assert.equal(listing.tenantPolicies.children, 'allowed');
  assert.ok(listing.financing.includes('mortgageAllowed'));
  assert.ok(listing.documentStatus.includes('cadastralReady'));
  assert.ok(listing.priceModifiers.includes('fixed'));
});

test('explicit inactive status is preserved for downstream feed exclusion', () => {
  const listing = makeListing({ ...base, id: 'ctx-4', title: 'Квартира уже сдана' });
  assert.equal(listing.listingStatus, 'rented');
});
