import assert from 'node:assert/strict';
import test from 'node:test';

import {closeDb, pool, upsertListings} from '../src/infrastructure/database/listingRepository.js';
import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';
import {searchPostgresListings} from '../src/postgres-search.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';
const SOURCE = 'general-cursor-scope-test';
const COUNTRY_A = 'RX';
const COUNTRY_B = 'RY';

function decodeCursor(value) {
  return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('general PostgreSQL cursor is bound to countries and semantic filters', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  await pool.query('DELETE FROM listings WHERE source = $1', [SOURCE]);

  const now = Date.now();
  await upsertListings([
    {
      id: 'general-scope-a-1',
      source: SOURCE,
      country: COUNTRY_A,
      title: 'General scope A one',
      description: 'General cursor scope fixture A one.',
      propertyType: 'flat',
      dealType: 'longRent',
      price: 501,
      currency: 'USD',
      city: 'Scoped City',
      createdAt: new Date(now - 60_000).toISOString(),
      commercial: false,
    },
    {
      id: 'general-scope-a-2',
      source: SOURCE,
      country: COUNTRY_A,
      title: 'General scope A two',
      description: 'General cursor scope fixture A two.',
      propertyType: 'flat',
      dealType: 'longRent',
      price: 502,
      currency: 'USD',
      city: 'Scoped City',
      createdAt: new Date(now - 120_000).toISOString(),
      commercial: false,
    },
    {
      id: 'general-scope-b-1',
      source: SOURCE,
      country: COUNTRY_B,
      title: 'General scope B one',
      description: 'General cursor scope fixture B one.',
      propertyType: 'flat',
      dealType: 'longRent',
      price: 503,
      currency: 'USD',
      city: 'Scoped City',
      createdAt: new Date(now - 30_000).toISOString(),
      commercial: false,
    },
  ]);

  const filters = {
    propertyType: 'any',
    dealType: 'any',
    agency: 'any',
    audience: 'any',
    city: 'Scoped City',
    sources: [],
    sort: 'newest',
    limit: 1,
    offset: 0,
    maxAgeDays: 14,
  };

  const first = await searchPostgresListings({filters, countries: [COUNTRY_A], rates: {USD: 1}});
  assert.equal(first.searchPath, 'postgres');
  assert.equal(first.count, 2);
  assert.equal(first.listings[0]?.id, 'general-scope-a-1');
  assert.ok(first.nextCursor);
  assert.equal(decodeCursor(first.nextCursor).c, 2);
  assert.ok(decodeCursor(first.nextCursor).s);

  const wrongCountry = await searchPostgresListings({
    filters: {...filters, cursor: first.nextCursor, offset: 999},
    countries: [COUNTRY_B],
    rates: {USD: 1},
  });
  assert.equal(wrongCountry.count, 1);
  assert.equal(wrongCountry.listings[0]?.id, 'general-scope-b-1');
  assert.equal(wrongCountry.nextCursor, null);

  const wrongFilter = await searchPostgresListings({
    filters: {...filters, city: 'No Such Scoped City', cursor: first.nextCursor, offset: 999},
    countries: [COUNTRY_A],
    rates: {USD: 1},
  });
  assert.equal(wrongFilter.count, 0);
  assert.deepEqual(wrongFilter.listings, []);

  const {s: _scope, ...legacyPayload} = decodeCursor(first.nextCursor);
  const legacy = encodeCursor({...legacyPayload, c: 999});
  const legacySecond = await searchPostgresListings({
    filters: {...filters, cursor: legacy, offset: 999},
    countries: [COUNTRY_A],
    rates: {USD: 1},
  });
  assert.equal(legacySecond.count, 2, 'legacy cursor count must be recalculated');
  assert.equal(legacySecond.listings[0]?.id, 'general-scope-a-2', 'legacy cursor position stays compatible');

  await pool.query('DELETE FROM listings WHERE source = $1', [SOURCE]);
  await closeDb();
});
