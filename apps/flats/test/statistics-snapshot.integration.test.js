import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';
import {pool} from '../src/infrastructure/database/listingRepository.js';
import {
  clearStatisticsSnapshotCache,
  computeStatisticsSnapshot,
  getFullStatisticsSnapshot,
  refreshStatisticsSnapshot,
} from '../src/support/statistics-snapshot.js';

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
  assert.match(source, /FROM listing_public_feed_members AS m/);
  // Winner selection is the persisted is_canonical flag (migration 040), not a
  // request-time join or ranking.
  assert.match(source, /WHERE m\.is_canonical/);
  assert.doesNotMatch(source, /PARTITION BY[^\n]*dedupe/i);
  // The snapshot projects the fields it needs out of the payload instead of
  // materializing every listing's JSONB.
  assert.doesNotMatch(source, /^\s*l\.data,?$/m);
  assert.match(source, /AS suspected_fake/);
  // Scalars come from one aggregate pass, not a scan per counter.
  assert.match(source, /COUNT\(\*\) FILTER \(WHERE by_agency = FALSE\)/);
  assert.doesNotMatch(source, /SELECT COUNT\(\*\)::int FROM visible WHERE/);
  assert.match(source, /SNAPSHOT_MEMO_MS/);
  assert.match(source, /inFlightSnapshot/);
});

test('serving statistics reads the stored snapshot instead of recomputing it', async () => {
  const source = await readFile(new URL('../src/support/statistics-snapshot.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
  const migrationSql = await readFile(
    new URL('../migrations/041_statistics_snapshot_store.sql', import.meta.url),
    'utf8',
  );

  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS listing_statistics_snapshots/);
  assert.match(source, /export async function refreshStatisticsSnapshot/);
  assert.match(source, /FROM listing_statistics_snapshots/);
  assert.match(source, /INSERT INTO listing_statistics_snapshots/);
  // A slow replica must never overwrite a newer snapshot.
  assert.match(source, /WHERE EXCLUDED\.generated_at > listing_statistics_snapshots\.generated_at/);
  // Clients that already hold the current generation get an empty 304.
  assert.match(source, /res\.set\('ETag', etag\)/);
  assert.match(source, /if-none-match/);
  // The refresh is the worker's job, on a timer, not a request's job.
  assert.match(worker, /async function statisticsTick/);
  assert.match(worker, /setInterval\(\(\) => void statisticsTick\(\), STATISTICS_REFRESH_MS\)/);
});

test('stored snapshot is served without recomputing', {skip: !enabled}, async () => {
  await assertDatabaseReady();

  const refreshed = await refreshStatisticsSnapshot();
  assert.ok(refreshed.generatedAt);

  // Drop the in-process memo so the next read has to come from the table.
  clearStatisticsSnapshotCache();
  const served = await getFullStatisticsSnapshot();

  assert.equal(served.generatedAt, refreshed.generatedAt, 'a fresh stored snapshot must be reused as-is');
  assert.equal(served.maxAgeDays, refreshed.maxAgeDays);
  assert.equal(served.statistics.total, refreshed.statistics.total);
  assert.equal(served.statistics.currency, 'USD');
});
