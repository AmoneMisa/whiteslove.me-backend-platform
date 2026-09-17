import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveListingLine, PHANTOM_MIN_PROPERTIES, STEADY_MIN_OBSERVATIONS } from '../src/identity/listing-line.js';
import { attachListingLines } from '../src/listing/listing-contact-actions.js';
import { loadStoredListingLines, refreshListingLines, findContactListings } from '../src/infrastructure/database/listingLineRepository.js';

const NOW = new Date('2026-09-01T00:00:00Z');
const seen = NOW.toISOString();
const risk = (reasonCode, dimension, independentCount, extra = {}) => ({ polarity: 'risk', reasonCode, dimension, independentCount, reviewState: 'open', lastObservedAt: seen, ...extra });
const trust = (reasonCode, dimension, independentCount, extra = {}) => ({ polarity: 'trust', reasonCode, dimension, independentCount, reviewState: 'open', lastObservedAt: seen, ...extra });
const line = (input) => resolveListingLine({ now: NOW, ...input }).line;

// --- grey ----------------------------------------------------------------------

test('nothing known and no other listings is grey', () => {
  assert.equal(line({}), null);
  assert.equal(line({ evidence: [], otherProperties: 0 }), null);
});

// --- purple --------------------------------------------------------------------

test('a contact with other properties is purple', () => {
  assert.equal(line({ otherProperties: 2 }), 'multi_listing');
});

// --- red ------------------------------------------------------------------------

test('strong phantom evidence across several properties is red', () => {
  assert.equal(line({ evidence: [risk('phantom_unavailable_inventory', 'availability_credibility', PHANTOM_MIN_PROPERTIES + 1)] }), 'phantom_risk');
});

test('one flat that rented fast is never red', () => {
  // False-positive guard: popular flats go quickly.
  assert.notEqual(line({ evidence: [risk('fresh_listing_immediately_unavailable', 'availability_credibility', 1)] }), 'phantom_risk');
  assert.notEqual(line({ evidence: [risk('phantom_unavailable_inventory', 'availability_credibility', PHANTOM_MIN_PROPERTIES - 1)] }), 'phantom_risk');
});

test('the operator\'s legacy blacklist never colours a card', () => {
  const evidence = Array.from({ length: 10 }, () => risk('legacy_registry_risk', 'identity_risk', 50));
  assert.equal(line({ evidence }), null);
  assert.equal(line({ evidence: [trust('legacy_registry_trust', 'identity_risk', 50)] }), null);
});

test('payment and identity risk alone never make a card red', () => {
  // Those dimensions are internal (§35); red needs listing-level phantom evidence.
  const evidence = [risk('payment_before_verification', 'payment_risk', 9), risk('undeclared_broker_pattern', 'identity_risk', 9)];
  assert.notEqual(line({ evidence }), 'phantom_risk');
});

// --- no yellow ----------------------------------------------------------------

test('there is no yellow line; inconsistencies only withhold green', () => {
  assert.equal(line({ evidence: [risk('repeated_fresh_relisting', 'provenance_risk', 1)] }), null);
  assert.equal(line({ evidence: [risk('repeated_fresh_relisting', 'provenance_risk', 1), trust('stable_identity', 'identity_risk', 20)] }), null);
});

test('red outranks purple', () => {
  assert.equal(line({ otherProperties: 5, evidence: [risk('phantom_unavailable_inventory', 'availability_credibility', 9)] }), 'phantom_risk');
  assert.equal(line({ otherProperties: 5, evidence: [risk('repeated_fresh_relisting', 'provenance_risk', 1)] }), 'multi_listing');
});

// --- green ---------------------------------------------------------------------

test('a long clean history is green', () => {
  assert.equal(line({ otherProperties: 4, evidence: [trust('stable_identity', 'identity_risk', STEADY_MIN_OBSERVATIONS)] }), 'steady');
});

test('any risk evidence withholds green', () => {
  const evidence = [trust('stable_identity', 'identity_risk', 20), risk('owner_identity_inconsistent', 'identity_risk', 1)];
  assert.notEqual(line({ evidence }), 'steady');
});

test('a short history is not green yet', () => {
  assert.equal(line({ evidence: [trust('stable_identity', 'identity_risk', STEADY_MIN_OBSERVATIONS - 1)] }), null);
});

// --- exclusions -------------------------------------------------------------------

test('restriction, objection, dispute and dismissal all remove the line', () => {
  const phantom = risk('phantom_unavailable_inventory', 'availability_credibility', 9);
  assert.equal(line({ restricted: true, evidence: [phantom], otherProperties: 3 }), null);
  assert.equal(line({ evidence: [{ ...phantom, underDispute: true }] }), null);
  assert.equal(line({ evidence: [{ ...phantom, reviewState: 'dismissed' }] }), null);
});

// --- attaching stored lines to a feed page -----------------------------------------

test('stored lines and contact counts are attached per listing in one lookup', async () => {
  let calls = 0;
  const listings = [{ id: '1', publicId: 11 }, { id: '2', publicId: 12 }, { id: '3', publicId: 13 }, { id: '4' }];
  const result = await attachListingLines(listings, {
    loadLines: async (ids) => {
      calls += 1;
      assert.deepEqual(ids, [11, 12, 13]);
      return new Map([[11, { line: 'multi_listing', otherProperties: 2 }], [12, { line: 'steady', otherProperties: 0 }]]);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.map((listing) => listing.listingLine ?? null), ['multi_listing', 'steady', null, null]);
  assert.deepEqual(result.map((listing) => listing.contactListingCount ?? null), [2, null, null, null]);
});

test('a failed lookup serves the feed without lines', async () => {
  const listings = [{ id: '1', publicId: 11, contact: '+998901234567' }];
  const logs = [];
  const result = await attachListingLines(listings, { loadLines: async () => { throw Object.assign(new Error('boom +998901234567'), { code: '57014' }); }, log: (line) => logs.push(line) });
  assert.equal(result, listings);
  assert.deepEqual(logs, ['[listing-line] skipped: 57014'], 'no contact values in logs');
});

test('stored lines are read by primary key only', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ listing_id: '11', line: 'steady', other_properties: 3 }] }; } };
  const lines = await loadStoredListingLines([11, 11, 'x', -1], client);
  assert.deepEqual(calls[0].params[0], [11]);
  assert.match(calls[0].sql, /WHERE listing_id = ANY\(\$1::bigint\[\]\)/u);
  assert.deepEqual(lines.get(11), { line: 'steady', otherProperties: 3 });
  assert.equal((await loadStoredListingLines([], client)).size, 0);
  assert.equal(calls.length, 1);
});

// --- refresh ----------------------------------------------------------------------

function refreshClient({ multi = [], evidence = [], listings = [] }) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/HAVING count\(DISTINCT dedupe_key\) > 1/u.test(sql)) return { rows: multi };
      if (/FROM platform\.actor_evidence e/u.test(sql)) return { rows: evidence };
      if (/SELECT id, data->>'contact' AS contact/u.test(sql)) return { rows: listings };
      if (/INSERT INTO platform\.listing_lines/u.test(sql)) return { rows: [{ upserted: params[0].length, removed: 0 }] };
      throw new Error(`unexpected query ${sql.slice(0, 40)}`);
    },
  };
}

const evidenceRow = (type, value, extra = {}) => ({ type, canonical_value: value, restricted: false, id: '1', polarity: 'risk', reason_code: 'phantom_unavailable_inventory', dimension: 'availability_credibility', independent_count: 9, review_state: 'open', last_observed_at: NOW, under_dispute: false, ...extra });

test('refresh resolves lines per contact and writes one row per listing', async () => {
  const client = refreshClient({
    multi: [{ contact: '+998900000001', properties: 3 }],
    evidence: [evidenceRow('phone', '+998900000002'), evidenceRow('telegram', 'owner_flat')],
    listings: [
      { id: '1', contact: '+998900000001' },
      { id: '2', contact: '+998900000001' },
      { id: '3', contact: '+998900000002' },
      { id: '4', contact: '@Owner_Flat' },
    ],
  });
  const result = await refreshListingLines({ client, now: NOW });
  const write = client.calls.find((call) => /INSERT INTO platform\.listing_lines/u.test(call.sql));
  assert.deepEqual(write.params[0], [1, 2, 3, 4]);
  assert.deepEqual(write.params[1], ['multi_listing', 'multi_listing', 'phantom_risk', 'phantom_risk'], 'Telegram handles match regardless of case');
  assert.deepEqual(write.params[2], [2, 2, 0, 0], 'other properties exclude the listing itself');
  assert.equal(result.contacts, 3);
  const expand = client.calls.find((call) => /SELECT id, data->>'contact' AS contact/u.test(call.sql));
  assert.deepEqual(expand.params, [['+998900000001', '+998900000002'], ['@owner_flat']]);
});

test('refresh clears the table when no contact has a line', async () => {
  const client = refreshClient({});
  const result = await refreshListingLines({ client, now: NOW });
  assert.equal(result.listings, 0);
  assert.ok(!client.calls.some((call) => /SELECT id, data->>'contact' AS contact/u.test(call.sql)), 'no expansion query without lines');
  const write = client.calls.find((call) => /INSERT INTO platform\.listing_lines/u.test(call.sql));
  assert.deepEqual(write.params, [[], [], []]);
  assert.match(write.sql, /DELETE FROM platform\.listing_lines ll\s+WHERE NOT EXISTS/u, 'stale rows are removed in the same statement');
  assert.match(write.sql, /WHERE platform\.listing_lines\.line IS DISTINCT FROM EXCLUDED\.line/u, 'unchanged rows are not rewritten');
});

test('restricted contacts get no stored line', async () => {
  const client = refreshClient({
    evidence: [evidenceRow('phone', '+998900000002', { restricted: true })],
    listings: [{ id: '3', contact: '+998900000002' }],
  });
  const result = await refreshListingLines({ client, now: NOW });
  assert.equal(result.contacts, 0);
});

// --- filters and contact listings ---------------------------------------------------

test('trusted and hide-danger toggles are parsed and reach both search paths', async () => {
  // The route and search modules load the encrypted geo catalog at import
  // (unavailable without GEO_CATALOG_DECRYPTION_KEY), so they are checked by
  // source here.
  const routes = await readFile(new URL('../src/routes/listing-routes.js', import.meta.url), 'utf8');
  assert.match(routes, /trustedOnly: bool\(q\.trustedOnly\),/u);
  assert.match(routes, /hideDanger: bool\(q\.hideDanger\),/u);

  const fast = await readFile(new URL('../src/infrastructure/search/postgres-search-fast-core.js', import.meta.url), 'utf8');
  assert.match(fast, /m\.listing_id IN \(SELECT ll\.listing_id FROM platform\.listing_lines ll WHERE ll\.line = 'steady'\)/u);
  assert.match(fast, /NOT EXISTS \(SELECT 1 FROM platform\.listing_lines ll WHERE ll\.listing_id = m\.listing_id AND ll\.line = 'phantom_risk'\)/u);

  const core = await readFile(new URL('../src/infrastructure/search/postgres-search-core.js', import.meta.url), 'utf8');
  assert.match(core, /l\.id IN \(SELECT ll\.listing_id FROM platform\.listing_lines ll WHERE ll\.line = 'steady'\)/u);
  assert.match(core, /ll\.listing_id = l\.id AND ll\.line = 'phantom_risk'/u);
});

test('contact listings are one per property, excluding the listing itself', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: '21', source: 'olx', country: 'UZ', source_id: 'a1', data: { title: 'Other flat', contact: '+998900000001' } }] }; } };
  const listings = await findContactListings(11, { limit: 500 }, client);
  assert.deepEqual(calls[0].params, [11, 50], 'limit is capped');
  assert.match(calls[0].sql, /DISTINCT ON \(l\.dedupe_key\)/u);
  assert.match(calls[0].sql, /l\.dedupe_key <> src\.dedupe_key/u);
  assert.deepEqual(listings[0], { title: 'Other flat', contact: '+998900000001', id: 'a1', source: 'olx', country: 'UZ', publicId: 21 });
  assert.equal(await findContactListings('nope', {}, client), null);
  assert.equal(calls.length, 1);
});

test('migration 057 stores only lined listings with an index for the trusted filter', async () => {
  const sql = await readFile(new URL('../migrations/057_listing_lines.sql', import.meta.url), 'utf8');
  assert.match(sql, /listing_id BIGINT PRIMARY KEY REFERENCES listings\(id\) ON DELETE CASCADE/u);
  assert.match(sql, /CHECK \(line IN \('steady', 'phantom_risk', 'multi_listing'\)\)/u);
  assert.match(sql, /ON platform\.listing_lines \(line, listing_id\)/u);
});

test('the worker refreshes lines and the API serves contact listings', async () => {
  const worker = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../src/routes/listing-item-routes.js', import.meta.url), 'utf8');
  assert.match(worker, /setInterval\(\(\) => void listingLinesTick\(\), LISTING_LINES_REFRESH_MS\)/u);
  assert.match(routes, /app\.get\('\/api\/listing\/by-public-id\/:publicId\/contact-listings'/u);
});

test('migration 056 indexes active contacts for an index-only count', async () => {
  const sql = await readFile(new URL('../migrations/056_listing_contact_index.sql', import.meta.url), 'utf8');
  assert.match(sql, /ON listings \(\(data->>'contact'\)\)\s+INCLUDE \(dedupe_key\)\s+WHERE active = TRUE/u);
});
