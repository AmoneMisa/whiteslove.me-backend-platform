import assert from 'node:assert/strict';
import test from 'node:test';

import {closeDb, pool, upsertListings} from '../src/infrastructure/database/listingRepository.js';
import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';
import {searchPostgresListings} from '../src/postgres-search-fast.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';
const SOURCE = 'fast-feed-pagination-test';
const COUNTRY = 'QX';
const OTHER_COUNTRY = 'QY';

function decodeCursor(value) {
  return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('fast default feed carries count and scopes cursor pagination to the active query', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  await pool.query('DELETE FROM listings WHERE source = $1', [SOURCE]);

  const now = Date.now();
  await upsertListings([
    {
      id: 'fast-feed-1',
      source: SOURCE,
      country: COUNTRY,
      title: 'Fast feed pagination one',
      description: 'Unique fast feed pagination fixture one.',
      propertyType: 'flat',
      dealType: 'longRent',
      price: 401,
      currency: 'USD',
      city: 'Fast Feed City',
      createdAt: new Date(now - 60_000).toISOString(),
      commercial: false,
    },
    {
      id: 'fast-feed-2',
      source: SOURCE,
      country: COUNTRY,
      title: 'Fast feed pagination two',
      description: 'Unique fast feed pagination fixture two.',
      propertyType: 'flat',
      dealType: 'longRent',
      price: 402,
      currency: 'USD',
      city: 'Fast Feed City',
      createdAt: new Date(now - 120_000).toISOString(),
      commercial: false,
    },
    {
      id: 'fast-feed-3',
      source: SOURCE,
      country: COUNTRY,
      title: 'Fast feed pagination three',
      description: 'Unique fast feed pagination fixture three.',
      propertyType: 'flat',
      dealType: 'longRent',
      price: 403,
      currency: 'USD',
      city: 'Fast Feed City',
      createdAt: new Date(now - 180_000).toISOString(),
      commercial: false,
    },
    {
      id: 'fast-feed-other-country',
      source: SOURCE,
      country: OTHER_COUNTRY,
      title: 'Fast feed other-country first page',
      description: 'Scope mismatch fixture.',
      propertyType: 'flat',
      dealType: 'longRent',
      price: 404,
      currency: 'USD',
      city: 'Other Fast Feed City',
      createdAt: new Date(now - 30_000).toISOString(),
      commercial: false,
    },
  ]);

  const filters = {
    propertyType: 'any',
    dealType: 'any',
    agency: 'any',
    audience: 'any',
    sources: [],
    sort: 'newest',
    limit: 1,
    offset: 0,
    maxAgeDays: 14,
  };

  const first = await searchPostgresListings({filters, countries: [COUNTRY], rates: {USD: 1}});
  assert.equal(first.searchPath, 'postgres-canonical-feed');
  assert.equal(first.count, 3);
  assert.equal(first.listings.length, 1);
  assert.equal(first.listings[0]?.id, 'fast-feed-1');
  assert.ok(first.nextCursor);
  assert.equal(decodeCursor(first.nextCursor).c, 3);
  assert.ok(decodeCursor(first.nextCursor).s, 'new cursors must carry a query-scope fingerprint');

  const mismatchedCursor = encodeCursor({...decodeCursor(first.nextCursor), sort: 'oldest', c: 999});
  const mismatched = await searchPostgresListings({
    filters: {...filters, cursor: mismatchedCursor, offset: 0},
    countries: [COUNTRY],
    rates: {USD: 1},
  });
  assert.equal(mismatched.count, 3, 'a cursor rejected by sort must not supply the carried count');
  assert.equal(mismatched.listings[0]?.id, 'fast-feed-1');

  const otherCountry = await searchPostgresListings({
    filters: {...filters, cursor: first.nextCursor, offset: 999},
    countries: [OTHER_COUNTRY],
    rates: {USD: 1},
  });
  assert.equal(otherCountry.count, 1, 'a cursor from another country scope must not supply its carried count');
  assert.equal(otherCountry.listings[0]?.id, 'fast-feed-other-country', 'scope mismatch must restart from the new query first page');
  assert.equal(otherCountry.nextCursor, null);

  const {s: _scope, ...legacyPayload} = decodeCursor(first.nextCursor);
  const legacy = encodeCursor({...legacyPayload, c: 999});
  const legacySecond = await searchPostgresListings({
    filters: {...filters, cursor: legacy, offset: 999},
    countries: [COUNTRY],
    rates: {USD: 1},
  });
  assert.equal(legacySecond.count, 3, 'legacy unscoped cursors must recalculate rather than trust carried count');
  assert.equal(legacySecond.listings[0]?.id, 'fast-feed-2', 'legacy cursor position remains backward compatible');

  const second = await searchPostgresListings({
    filters: {...filters, cursor: first.nextCursor, offset: 999},
    countries: [COUNTRY],
    rates: {USD: 1},
  });
  assert.equal(second.count, 3);
  assert.equal(second.listings.length, 1);
  assert.equal(second.listings[0]?.id, 'fast-feed-2');
  assert.ok(second.nextCursor);
  assert.equal(decodeCursor(second.nextCursor).c, 3);
  assert.equal(decodeCursor(second.nextCursor).s, decodeCursor(first.nextCursor).s);

  const third = await searchPostgresListings({
    filters: {...filters, cursor: second.nextCursor, offset: 999},
    countries: [COUNTRY],
    rates: {USD: 1},
  });
  assert.equal(third.count, 3);
  assert.equal(third.listings.length, 1);
  assert.equal(third.listings[0]?.id, 'fast-feed-3');
  assert.equal(third.nextCursor, null);

  await pool.query('DELETE FROM listings WHERE source = $1', [SOURCE]);
  await closeDb();
});
