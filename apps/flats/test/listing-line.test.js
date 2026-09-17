import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveListingLine, PHANTOM_MIN_PROPERTIES, STEADY_MIN_OBSERVATIONS } from '../src/identity/listing-line.js';
import { attachListingLines } from '../src/listing/listing-contact-actions.js';
import { loadListingLineInputs } from '../src/infrastructure/database/listingLineRepository.js';

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

// --- yellow -------------------------------------------------------------------

test('inconsistencies worth checking are yellow', () => {
  assert.equal(line({ evidence: [risk('repeated_fresh_relisting', 'provenance_risk', 1)] }), 'check');
});

test('red and yellow outrank purple', () => {
  assert.equal(line({ otherProperties: 5, evidence: [risk('repeated_fresh_relisting', 'provenance_risk', 1)] }), 'check');
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

// --- attaching to a feed page ------------------------------------------------------

test('lines are attached per listing, in one lookup for the page', async () => {
  let calls = 0;
  const listings = [{ id: '1', contact: '+998901234567' }, { id: '2', contact: '+998901234567' }, { id: '3' }];
  const result = await attachListingLines(listings, {
    loadInputs: async (contacts) => { calls += 1; assert.equal(contacts.length, 2); return new Map([['+998901234567', { otherProperties: 1, evidence: [] }]]); },
    resolveLine: resolveListingLine,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.map((listing) => listing.listingLine ?? null), ['multi_listing', 'multi_listing', null]);
});

test('a failed lookup serves the feed without lines', async () => {
  const listings = [{ id: '1', contact: '+998901234567' }];
  const logs = [];
  const result = await attachListingLines(listings, { loadInputs: async () => { throw Object.assign(new Error('boom +998901234567'), { code: '57014' }); }, resolveLine: resolveListingLine, log: (line) => logs.push(line) });
  assert.equal(result, listings);
  assert.deepEqual(logs, ['[listing-line] skipped: 57014'], 'no contact values in logs');
});

test('the repository counts distinct properties and excludes the listing itself', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/count\(DISTINCT dedupe_key\)/u.test(sql)) return { rows: [{ contact: '+998901234567', properties: 3 }, { contact: '@solo_owner', properties: 1 }] };
      return { rows: [{ type: 'phone', value: '+998901234567', restricted: false, id: '7', polarity: 'risk', reason_code: 'copied_inventory', dimension: 'provenance_risk', independent_count: 2, review_state: 'open', last_observed_at: NOW, under_dispute: true }] };
    },
  };
  const inputs = await loadListingLineInputs([
    { contact: '+998901234567', type: 'phone', canonicalValue: '+998901234567' },
    { contact: '+998901234567', type: 'phone', canonicalValue: '+998901234567' },
    { contact: '@solo_owner', type: 'telegram', canonicalValue: 'solo_owner' },
  ], client);
  assert.equal(calls.length, 2, 'two queries for the whole page');
  assert.deepEqual(calls[0].params[0], ['+998901234567', '@solo_owner'], 'contacts deduplicated');
  assert.equal(inputs.get('+998901234567').otherProperties, 2);
  assert.equal(inputs.get('@solo_owner').otherProperties, 0);
  assert.equal(inputs.get('+998901234567').evidence[0].underDispute, true);
});

test('migration 056 indexes active contacts for an index-only count', async () => {
  const sql = await readFile(new URL('../migrations/056_listing_contact_index.sql', import.meta.url), 'utf8');
  assert.match(sql, /ON listings \(\(data->>'contact'\)\)\s+INCLUDE \(dedupe_key\)\s+WHERE active = TRUE/u);
});
