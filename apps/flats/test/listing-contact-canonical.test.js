import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { canonicalListingContact } from '../src/listing/contact-canonical.js';
import { planContactBackfill, runContactBackfillBatch } from '../src/maintenance/contact-backfill.js';

test('a local number becomes E.164 using the listing country', () => {
  assert.equal(canonicalListingContact('90 123 45 67', 'UZ'), '+998901234567');
  assert.equal(canonicalListingContact('(90) 123-45-67', 'UZ'), '+998901234567');
  // Uzbekistan has no leading-0 trunk prefix, so a 0-prefixed number is not a
  // valid Uzbek number and is kept as written rather than guessed.
  assert.equal(canonicalListingContact('(090) 123-45-67', 'UZ'), '(090) 123-45-67');
  assert.equal(canonicalListingContact('+998 90 123-45-67', 'UZ'), '+998901234567');
});

test('the same local digits mean different numbers in different countries', () => {
  const ua = canonicalListingContact('067 123 45 67', 'UA');
  assert.equal(ua, '+380671234567');
  assert.notEqual(canonicalListingContact('067 123 45 67', 'RO'), ua);
});

test('an international number is kept even when the listing country differs', () => {
  assert.equal(canonicalListingContact('+380 67 123 45 67', 'UZ'), '+380671234567');
});

test('Telegram handles are stored lower-case with @', () => {
  assert.equal(canonicalListingContact('@Owner_Flat', 'UZ'), '@owner_flat');
  assert.equal(canonicalListingContact('https://t.me/Some_Agent', 'UZ'), '@some_agent');
});

test('unrecognised contacts are kept, not dropped', () => {
  assert.equal(canonicalListingContact('  call the concierge  ', 'UZ'), 'call the concierge');
  assert.equal(canonicalListingContact('123', 'UZ'), '123');
  assert.equal(canonicalListingContact('', 'UZ'), null);
  assert.equal(canonicalListingContact(null, 'UZ'), null);
  const structured = { phone: '901234567' };
  assert.equal(canonicalListingContact(structured, 'UZ'), structured, 'structured contacts are left as they are');
});

test('a missing or invalid country still normalises international numbers', () => {
  assert.equal(canonicalListingContact('+998901234567', ''), '+998901234567');
  assert.equal(canonicalListingContact('+998901234567', 'Uzbekistan'), '+998901234567');
});

test('the backfill plans only rows whose stored form changes', () => {
  const changes = planContactBackfill([
    { id: 1, country: 'UZ', contact: '90 123 45 67' },
    { id: 2, country: 'UZ', contact: '+998901234567' },
    { id: 3, country: 'UZ', contact: '@Owner_Flat' },
    { id: 4, country: 'UZ', contact: 'call the concierge' },
    { id: 5, country: 'UZ', contact: null },
  ]);
  assert.deepEqual(changes, [
    { id: '1', from: '90 123 45 67', to: '+998901234567' },
    { id: '3', from: '@Owner_Flat', to: '@owner_flat' },
  ]);
});

test('a dry-run batch reads by keyset and writes nothing', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: '7', country: 'UZ', contact: '90 123 45 67' }], rowCount: 1 }; } };
  const batch = await runContactBackfillBatch(client, { afterId: 5, batchSize: 100 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE id > \$1::bigint/u);
  assert.deepEqual(calls[0].params, ['5', 100, null, false]);
  assert.equal(batch.changes.length, 1);
  assert.equal(batch.updated, 0);
  assert.equal(batch.nextAfterId, '7');
});

test('an applied batch updates changed contacts in one guarded statement', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return calls.length === 1 ? { rows: [{ id: '7', country: 'UZ', contact: '90 123 45 67' }, { id: '8', country: 'UZ', contact: '+998901234567' }] } : { rowCount: 1 };
    },
  };
  const batch = await runContactBackfillBatch(client, { apply: true, country: 'UZ' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, [['7'], ['+998901234567']]);
  assert.match(calls[1].sql, /IS DISTINCT FROM input\.contact/u, 'rows changed since reading are skipped');
  assert.equal(batch.updated, 1);
});

test('ingest stores the canonical contact', async () => {
  const source = await readFile(new URL('../src/listing/normalize-legacy.js', import.meta.url), 'utf8');
  assert.match(source, /canonicalListingContact\(partial\.contact \?\? parsePrimaryContact\(combined\), country\)/u);
});
