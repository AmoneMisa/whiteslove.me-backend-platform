import test from 'node:test';
import assert from 'node:assert/strict';

import { applyStructuredAddressFields } from '../src/geo/structured-address.js';

test('explicit source address is not replaced by a different address-like phrase in prose', () => {
  const listing = {
    address: 'ул. Шота Руставели 17',
    title: 'Квартира',
    description: 'Офис рядом: ул. Амир Темур 5',
    locationEntities: [],
  };

  applyStructuredAddressFields(listing);

  assert.equal(listing.street, 'Шота Руставели');
  assert.equal(listing.houseNumber, '17');
  assert.equal(listing.addressSource, 'source');
  assert.equal(listing.addressPrecision, 'building');
});

test('address already extracted from the same prose keeps parsed provenance', () => {
  const listing = {
    address: 'Шота Руставели 17',
    street: 'Шота Руставели',
    title: 'Квартира',
    description: 'Адрес: ул. Шота Руставели 17',
    locationEntities: [],
  };

  applyStructuredAddressFields(listing);

  assert.equal(listing.houseNumber, '17');
  assert.equal(listing.addressSource, 'parsed');
});

test('nearby prose street and house are not upgraded into the property exact address', () => {
  const listing = {
    address: 'Шота Руставели 17',
    street: 'Шота Руставели',
    title: 'Квартира',
    description: 'Рядом с ул. Шота Руставели 17',
    locationEntities: [
      { type: 'street', name: 'Шота Руставели', role: 'nearby' },
    ],
  };

  applyStructuredAddressFields(listing);

  assert.equal(listing.address, null);
  assert.equal(listing.houseNumber, null);
  assert.equal(listing.addressSource, 'parsedNearby');
  assert.equal(listing.addressApproximate, true);
  assert.equal(listing.street, 'Шота Руставели');
});
