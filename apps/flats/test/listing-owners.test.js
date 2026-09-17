import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  refreshListingLines, refreshListingOwners, listOwners, getOwner, isOwnerKey, parseOwnerCursor,
} from '../src/infrastructure/database/listingLineRepository.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const KEY = 'a'.repeat(24);

test('owner keys and cursors are validated before any query', () => {
  assert.equal(isOwnerKey(KEY), true);
  for (const value of ['', 'A'.repeat(24), 'a'.repeat(23), "aaaaaaaaaaaaaaaaaaaaaaa'", '+998901234567', null]) assert.equal(isOwnerKey(value), false, String(value));
  assert.deepEqual(parseOwnerCursor(`12:${KEY}`), { properties: 12, ownerKey: KEY });
  assert.equal(parseOwnerCursor('12'), null);
  assert.equal(parseOwnerCursor(`x:${KEY}`), null);
});

test('the owners refresh builds 2+ property owners from identifiers only, skipping restricted contacts', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ owners: 3, upserted: 1, removed: 2 }] }; } };
  const result = await refreshListingOwners({ client, restrictedContacts: ['+998900000009'] });
  assert.equal(calls.length, 1, 'one statement');
  const { sql, params } = calls[0];
  assert.match(sql, /HAVING count\(DISTINCT dedupe_key\) >= 2/u, 'two or more distinct properties');
  assert.match(sql, /data->>'contact' ~ \$2/u);
  assert.equal(params[1], '^(\\+[1-9][0-9]{6,14}|@[a-z0-9_]{5,32})$', 'only normalised phones and handles form owners');
  assert.deepEqual(params[0], ['+998900000009']);
  assert.match(sql, /NOT \(m\.contact = ANY\(\$1::text\[\]\)\)/u);
  assert.match(sql, /left\(encode\(sha256\(convert_to\(m\.contact, 'UTF8'\)\), 'hex'\), 24\) AS owner_key/u, 'opaque key, not the number');
  assert.match(sql, /DELETE FROM platform\.listing_owners o\s+WHERE NOT EXISTS/u);
  assert.match(sql, /IS DISTINCT FROM/u, 'unchanged owners are not rewritten');
  assert.deepEqual({ owners: result.owners, upserted: result.upserted, removed: result.removed }, { owners: 3, upserted: 1, removed: 2 });
});

test('the lines refresh reports restricted contacts for the owners refresh', async () => {
  const client = {
    query: async (sql) => {
      if (/HAVING count\(DISTINCT dedupe_key\) > 1/u.test(sql)) return { rows: [] };
      if (/FROM platform\.actor_evidence e/u.test(sql)) {
        return { rows: [{ type: 'phone', canonical_value: '+998900000009', restricted: true, id: '1', polarity: 'trust', reason_code: 'stable_identity', dimension: 'identity_risk', independent_count: 9, review_state: 'open', last_observed_at: new Date(), under_dispute: false }] };
      }
      return { rows: [{ upserted: 0, removed: 0 }] };
    },
  };
  const result = await refreshListingLines({ client });
  assert.deepEqual(result.restrictedContacts, ['+998900000009']);
});

test('owners are paged per country by keyset, largest first', async () => {
  const calls = [];
  const row = (key, properties) => ({ owner_key: key, contact: '+998900000001', country: 'UZ', city: 'Tashkent', properties, listings: properties + 1, line: 'multi_listing', sample_public_id: '5', sample_title: 'Flat', sample_photo: 'https://img.test/1.jpg' });
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [row('b'.repeat(24), 9), row('c'.repeat(24), 4), row('d'.repeat(24), 3)] }; } };
  const page = await listOwners({ country: 'UZ', limit: 2, after: { properties: 12, ownerKey: KEY } }, client);
  assert.deepEqual(calls[0].params, ['UZ', 3, 12, KEY]);
  assert.match(calls[0].sql, /ORDER BY o\.properties DESC, o\.owner_key/u);
  assert.match(calls[0].sql, /o\.properties < \$3 OR \(o\.properties = \$3 AND o\.owner_key > \$4\)/u);
  assert.doesNotMatch(calls[0].sql, /count\(|OFFSET/iu);
  assert.equal(page.owners.length, 2);
  assert.equal(page.next, `4:${'c'.repeat(24)}`);
  assert.deepEqual(page.owners[0].sample, { publicId: 5, title: 'Flat', photo: 'https://img.test/1.jpg' });
  assert.deepEqual(await listOwners({ country: 'uzbekistan' }, client), { owners: [], next: null });
  assert.equal(calls.length, 1);
});

test('a single owner is looked up by key only', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ owner_key: KEY, contact: '@agent_one', country: 'UZ', city: null, properties: 2, listings: 2, line: null }] }; } };
  const owner = await getOwner(KEY, client);
  assert.deepEqual(calls[0].params, [KEY]);
  assert.equal(owner.contact, '@agent_one');
  assert.equal(owner.sample, null);
  assert.equal(await getOwner('+998900000001', client), null);
  assert.equal(calls.length, 1);
});

test('the owner filter reaches both search paths and the fast listing path', async () => {
  const routes = await read('src/routes/listing-routes.js');
  const fast = await read('src/infrastructure/search/postgres-search-fast-core.js');
  const core = await read('src/infrastructure/search/postgres-search-core.js');
  assert.match(routes, /owner: \/\^\[0-9a-f\]\{24\}\$\/u\.test\(String\(q\.owner \|\| ''\)\) \? String\(q\.owner\) : ''/u);
  assert.match(fast, /m\.listing_id IN \(SELECT ol\.id FROM listings ol WHERE ol\.active = TRUE AND ol\.data->>'contact' = \(SELECT o\.contact FROM platform\.listing_owners o WHERE o\.owner_key = \$\{add\(filters\.owner\)\}\)\)/u);
  assert.match(fast, /filters\.query \|\| filters\.owner \|\|/u);
  assert.match(core, /l\.data->>'contact' = \(SELECT o\.contact FROM platform\.listing_owners o WHERE o\.owner_key = \$\{add\(filters\.owner\)\}\)/u);
});

test('routes, worker and migration are wired', async () => {
  const items = await read('src/routes/listing-item-routes.js');
  const worker = await read('src/worker.js');
  const migration = await read('migrations/058_listing_owners.sql');
  assert.match(items, /app\.get\('\/api\/owners'/u);
  assert.match(items, /app\.get\('\/api\/owners\/:ownerKey'/u);
  assert.match(worker, /refreshListingOwners\(\{restrictedContacts: result\.restrictedContacts\}\)/u);
  assert.match(migration, /properties INTEGER NOT NULL CHECK \(properties >= 2\)/u);
  assert.match(migration, /ON platform\.listing_owners \(country, properties DESC, owner_key\)/u);
});
