import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, pool, upsertListings } from '../src/db.js';
import { assertDatabaseReady } from '../src/db-ready.js';
import { attachMarketComparisons } from '../src/market-comparison.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';

test('PostgreSQL market comparison marks a listing below its comparable median', { skip: !enabled }, async () => {
  await assertDatabaseReady();
  await pool.query(`DELETE FROM listings WHERE source = 'market-comparison-test'`);

  const now = Date.now();
  const listing = (id, price, district = 'Chilanzar', rooms = 2, areaSqm = 50) => ({
    id,
    source: 'market-comparison-test',
    country: 'UZ',
    title: `Market ${id}`,
    description: 'database market comparison integration listing',
    propertyType: 'flat',
    dealType: 'longRent',
    byAgency: false,
    price,
    currency: 'USD',
    rooms,
    areaSqm,
    city: 'Tashkent',
    district,
    createdAt: new Date(now - 60_000).toISOString(),
    commercial: false,
  });

  const target = listing('target', 240);
  await upsertListings([
    target,
    listing('low', 200),
    listing('middle', 300),
    listing('high', 400),
    listing('higher', 500),
    listing('other-district', 50, 'Yakkasaray'),
    listing('other-rooms', 60, 'Chilanzar', 1, 50),
  ]);

  const [enriched] = await attachMarketComparisons([target], { USD: 1 });

  assert.equal(enriched.marketComparison.comparableCount, 5);
  assert.equal(enriched.marketComparison.medianUsd, 300);
  assert.equal(enriched.marketComparison.goodPrice, true);

  await pool.query(`DELETE FROM listings WHERE source = 'market-comparison-test'`);
  await closeDb();
});
