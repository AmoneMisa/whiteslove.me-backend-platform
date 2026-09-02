import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const {Client} = pg;
const connectionString = process.env.TEST_POSTGRES_URL || '';
const migrationsDir = new URL('../migrations/', import.meta.url);

async function migration(name) {
  return readFile(new URL(name, migrationsDir), 'utf8');
}

async function bootstrap(client) {
  await client.query(await migration('001_baseline_listings.sql'));
  await client.query(await migration('010_persisted_dedupe_key.sql'));
  await client.query(await migration('014_public_feed_members.sql'));
  await client.query(await migration('037_canonical_public_feed.sql'));
}

async function insertOlx(client, sourceId, createdAt, photos) {
  const result = await client.query(`
    INSERT INTO listings (
      source, country, source_id, title, description, property_type, deal_type,
      city, price, currency, rooms, area_sqm, data, created_at
    ) VALUES (
      'olx', 'UZ', $1, 'Same apartment', 'Same apartment description', 'flat',
      'longRent', 'Tashkent', 500, 'USD', 2, 55, $2::jsonb, $3::timestamptz
    )
    RETURNING id, dedupe_key
  `, [sourceId, JSON.stringify({photos}), createdAt]);
  return result.rows[0];
}

test('canonical public feed chooses and maintains the winner at write time', {skip: !connectionString}, async () => {
  const client = new Client({connectionString});
  const schema = `canonical_feed_test_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await bootstrap(client);

    const photos = [
      'https://img.example.test/apartment/one-1234567890.jpg',
      'https://img.example.test/apartment/two-1234567890.jpg',
    ];
    const older = await insertOlx(client, 'older', '2026-08-31T12:00:00Z', photos);
    const newer = await insertOlx(client, 'newer', '2026-08-31T13:00:00Z', photos);
    assert.equal(older.dedupe_key, newer.dedupe_key);

    let canonical = await client.query(`
      SELECT c.dedupe_key, c.listing_id, l.source_id
      FROM listing_public_feed_canonical c
      JOIN listings l ON l.id = c.listing_id
    `);
    assert.equal(canonical.rows.length, 1);
    assert.equal(canonical.rows[0].source_id, 'newer');
    assert.equal(String(canonical.rows[0].listing_id), String(newer.id));

    await client.query(`UPDATE listings SET active = FALSE WHERE id = $1`, [newer.id]);
    canonical = await client.query(`
      SELECT c.listing_id, l.source_id
      FROM listing_public_feed_canonical c
      JOIN listings l ON l.id = c.listing_id
    `);
    assert.equal(canonical.rows.length, 1);
    assert.equal(canonical.rows[0].source_id, 'older');
    assert.equal(String(canonical.rows[0].listing_id), String(older.id));

    await client.query(`UPDATE listings SET active = TRUE WHERE id = $1`, [newer.id]);
    canonical = await client.query(`
      SELECT c.listing_id, l.source_id
      FROM listing_public_feed_canonical c
      JOIN listings l ON l.id = c.listing_id
    `);
    assert.equal(canonical.rows.length, 1);
    assert.equal(canonical.rows[0].source_id, 'newer');
  } finally {
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

test('structured canonical feed reads winners without request-time dedupe ranking', async () => {
  const migrationSql = await migration('037_canonical_public_feed.sql');
  const feedSql = await readFile(
    new URL('../src/support/postgres-canonical-feed.js', import.meta.url),
    'utf8',
  );
  const routerSql = await readFile(
    new URL('../src/support/postgres-search-fast.js', import.meta.url),
    'utf8',
  );

  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS listing_public_feed_canonical/);
  assert.match(migrationSql, /pg_advisory_xact_lock/);
  assert.match(migrationSql, /AFTER INSERT OR DELETE OR UPDATE OF dedupe_key, created_at/);
  assert.match(feedSql, /JOIN listing_public_feed_members AS m[\s\S]*canonical\.listing_id/);
  assert.doesNotMatch(feedSql, /ROW_NUMBER\s*\(/);
  assert.doesNotMatch(feedSql, /DISTINCT ON\s*\(/);
  assert.match(feedSql, /priceAsc/);
  assert.match(feedSql, /priceDesc/);
  assert.match(routerSql, /canUseCanonicalFeedPath/);
  assert.match(routerSql, /searchCanonicalFeed/);
});
