import test from 'node:test';
import assert from 'node:assert/strict';

import {mobilePresetSearch} from '../src/mobile-subscriptions.js';

test('mobile preset snapshot becomes the canonical apartment search filter', () => {
  const result = mobilePresetSearch({
    countries: ['UZ'],
    sources: ['olx', 'telegram'],
    city: 'Tashkent',
    dealType: 'longRent',
    priceMax: 900,
    priceCurrency: 'USD',
    roomOnly: true,
    amenities: ['airConditioner', 'parking'],
    sort: 'priceAsc',
  });

  assert.deepEqual(result.countries, ['UZ']);
  assert.equal(result.filters.city, 'Tashkent');
  assert.equal(result.filters.dealType, 'roomRent');
  assert.equal(result.filters.priceMax, 900);
  assert.equal(result.filters.priceCurrency, 'USD');
  assert.equal(result.filters.roomOnly, null);
  assert.equal(result.filters.airConditioner, true);
  assert.equal(result.filters.parking, true);
  assert.deepEqual(result.filters.sources, ['olx', 'telegram']);
  assert.equal(result.filters.sort, 'newest');
  assert.equal(result.filters.limit, 60);
});