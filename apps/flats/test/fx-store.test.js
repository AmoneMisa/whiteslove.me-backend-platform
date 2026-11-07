import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {refreshStoredFxRates, storableRates} from '../src/support/fx-store.js';

function fakeDb(recomputed = 7) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({sql: String(sql).trim().split(/\s+/)[0], params});
      return {rowCount: /^UPDATE/i.test(String(sql).trim()) ? recomputed : 0};
    },
    release() { calls.push({sql: 'RELEASE'}); },
  };
  return {calls, db: {async connect() { return client; }}};
}

test('storableRates keeps positive finite ISO-4217-shaped rates only', () => {
  assert.deepEqual(
    storableRates({usd: 1, EUR: 0.9, BAD: 0, XX: 2, NaN: 'x', UZS: -3, KZT: 470}),
    [['USD', 1], ['EUR', 0.9], ['KZT', 470]],
  );
});

test('fallback-only rates never overwrite stored live rates', async () => {
  const {calls, db} = fakeDb();
  const result = await refreshStoredFxRates({db, fetchRates: async () => ({at: 0, rates: {USD: 1, EUR: 0.92}})});
  assert.deepEqual(result, {live: false, rates: 0, recomputed: 0});
  assert.equal(calls.length, 0);
});

test('live rates are upserted then price_usd is recomputed in one transaction', async () => {
  const {calls, db} = fakeDb(7);
  const result = await refreshStoredFxRates({db, fetchRates: async () => ({at: 1, rates: {USD: 1, EUR: 0.9}})});
  assert.deepEqual(result, {live: true, rates: 2, recomputed: 7});
  assert.deepEqual(calls.map((c) => c.sql), ['BEGIN', 'INSERT', 'UPDATE', 'COMMIT', 'RELEASE']);
  assert.deepEqual(calls[1].params, [['USD', 'EUR'], [1, 0.9]]);
});

test('rates without a USD base are rejected and rolled back safely', async () => {
  const {calls, db} = fakeDb();
  await assert.rejects(
    refreshStoredFxRates({db, fetchRates: async () => ({at: 1, rates: {EUR: 0.9}})}),
    /no USD base/,
  );
  assert.equal(calls.length, 0);
});

test('migration 067 backfills after building indexes', async () => {
  const sql = await readFile(new URL('../migrations/067_feed_member_price_usd.sql', import.meta.url), 'utf8');
  assert.ok(sql.lastIndexOf('CREATE INDEX') < sql.lastIndexOf('SET price_usd = feed_member_price_usd'));
});

test('feed sorts and price filters read the stored column, not a per-row CASE', async () => {
  for (const file of ['../src/support/postgres-canonical-feed.js', '../src/infrastructure/search/postgres-search-fast-core.js']) {
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /price_usd/);
    assert.doesNotMatch(src, /CASE UPPER\(/);
  }
});
