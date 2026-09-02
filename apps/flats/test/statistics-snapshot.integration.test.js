import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';
import {pool} from '../src/infrastructure/database/listingRepository.js';
import {computeStatisticsSnapshot} from '../src/support/statistics-snapshot.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';
const SOURCE = 'statistics-snapshot-test';
const COUNTRY = 'QZ';

async function insertListing({sourceId, dealType, price, byAgency, createdAt}) {
  await pool.query(`
    INSERT INTO listings (
      source, country, source_id, title, description, property_type, deal_type,
      city, district, price, currency, rooms, area_sqm, by_agency, created_at, data
    ) VALUES (
      $1, $2, $3, $4, $5, 'flat', $6,
      'Snapshot City', 'Snapshot District', $7, 'USD', 2, 55, $8, $9::timestamptz,
      $10::jsonb
    )
  `, [
    SOURCE,
    COUNTRY,
    sourceId,
    `Snapshot ${sourceId}`,
    `Unique snapshot fixture ${sourceId}`,
    dealType,
    price,
    byAgency,
    createdAt,
    JSON.stringify({commission: byAgency}),
  ]);
}

test('full statistics snapshot reads canonical winners and preserves aggregate shape', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  await pool.query('DELETE FROM listings WHERE source = $1', [SOURCE]);
  try {
    const now = Date.now();
    await insertListing({
      sourceId: 'rent-owner',
      dealType: 'longRent',
      price: 500,
      byAgency: false,
      createdAt: new Date(now - 60_000).toISOString(),
    });
    await insertListing({
      sourceId: 'sale-agency',
      dealType: 'sale',
      price: 100000,
      byAgency: true,
      createdAt: new Date(now - 120_000).toISOString(),
    });

    const stats = await computeStatisticsSnapshot({
      countries: [COUNTRY],
      rates: {USD: 1},
    });

    assert.equal(stats.total, 2);
    assert.equal(stats.rawTotal, 2);
    assert.equal(stats.currency, 'USD');
    assert.equal(stats.ownership.owners, 1);
    assert.equal(stats.ownership.agencies, 1);
    assert.equal(stats.quality.duplicatesRejected, 0);

    const deals = new Map(stats.dealTypes.map((row) => [row.key, row]));
    assert.equal(deals.get('longRent')?.count, 1);
    assert.equal(deals.get('sale')?.count, 1);
    assert.equal(Number(deals.get('longRent')?.medianUsd), 500);
    assert.equal(Number(deals.get('sale')?.medianUsd), 100000);
    assert.equal(stats.geographies.city?.[0]?.label, 'Snapshot City');
  } finally {
    await pool.query('DELETE FROM listings WHERE source = $1', [SOURCE]);
  }
});

test('statistics snapshot avoids request-time dedupe ranking', async () => {
  const source = await readFile(new URL('../src/support/statistics-snapshot.js', import.meta.url), 'utf8');
  assert.match(source, /listing_public_feed_canonical/);
  assert.match(source, /JOIN listing_public_feed_members AS m/);
  assert.doesNotMatch(source, /PARTITION BY[^\n]*dedupe/i);
  assert.match(source, /SNAPSHOT_TTL_MS/);
  assert.match(source, /inFlightSnapshot/);
});
