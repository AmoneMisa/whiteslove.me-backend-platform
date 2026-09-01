import test from 'node:test';
import assert from 'node:assert/strict';
import {makeListing} from '../src/normalize.js';

test('minimum rental term is exposed under canonical minLeaseTerm', () => {
  const listing = makeListing({
    id: '42',
    source: 'olx',
    country: 'UZ',
    title: 'Квартира',
    description: '',
    minRentTerm: '6 months',
  });

  assert.equal(listing.minLeaseTerm, '6 months');
  assert.equal(listing.minRentTerm, '6 months', 'legacy alias remains during migration');
});

test('canonical minLeaseTerm takes precedence over the legacy alias', () => {
  const listing = makeListing({
    id: '42',
    source: 'olx',
    country: 'UZ',
    title: 'Квартира',
    description: '',
    minLeaseTerm: '12 months',
    minRentTerm: '6 months',
  });

  assert.equal(listing.minLeaseTerm, '12 months');
  assert.equal(listing.minRentTerm, '12 months');
});
