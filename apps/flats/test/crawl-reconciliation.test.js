import test from 'node:test';
import assert from 'node:assert/strict';

import { olxSegmentDealType } from '../src/geo/olx-segment.js';

test('OLX sale segment maps to sale', () => {
  assert.equal(olxSegmentDealType('flat:sale'), 'sale');
});

test('OLX long-rent segment maps to longRent', () => {
  assert.equal(olxSegmentDealType('flat:longRent'), 'longRent');
});

test('OLX short-rent segment maps to shortRent', () => {
  assert.equal(olxSegmentDealType('flat:shortRent'), 'shortRent');
});

test('unsupported segment does not become an authoritative scope', () => {
  assert.equal(olxSegmentDealType('flat:unsupported'), null);
});
