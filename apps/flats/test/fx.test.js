import assert from 'node:assert/strict';
import test from 'node:test';

import { toUsd, getRates } from '../src/support/fx.js';

test('fallback rate table covers every currency a supported country prices in', async () => {
  // Regression: KGS was missing from fx.js's FALLBACK table entirely, so a
  // KG (Kyrgyzstan) listing silently failed to convert to USD (toUsd returns
  // null with no rate for the currency) any time the live FX API was down.
  const { rates } = await getRates();
  for (const currency of ['USD', 'EUR', 'RON', 'UAH', 'KZT', 'KGS', 'UZS']) {
    assert.ok(rates[currency] > 0, `missing/invalid rate for ${currency}`);
  }
});

test('toUsd converts a KGS amount using the given rate table', () => {
  const rates = { USD: 1, KGS: 87.5 };
  assert.equal(toUsd(8750, 'KGS', rates), 100);
});

test('toUsd returns null for a currency absent from the rate table', () => {
  assert.equal(toUsd(100, 'XYZ', { USD: 1 }), null);
});
