import test from 'node:test';
import assert from 'node:assert/strict';
import {groupDuplicateListings, snapshotEvents, readListingActivity, loadActivitySummaries} from '../src/infrastructure/database/listingActivityRepository.js';

const listing = (id, extra = {}) => ({id, source: 'olx', source_id: String(id),
  data: {contact: '+380991234567', byAgency: false, sellerType: 'owner'}, price: 500, currency: 'USD', active: true, ...extra});

test('duplicates separate unknown and different contacts without declaring an owner verified', () => {
  const groups = groupDuplicateListings([
    listing(1), listing(2),
    listing(3, {data: {contact: '+380991234568', byAgency: true, commission: true}}),
    listing(4, {data: {}}), listing(5, {data: {}}),
  ], 1);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].sameAdvertiser, true);
  assert.equal(groups[0].listings.length, 2);
  assert.equal(groups[0].listings[0].advertiserType, 'owner_claim');
  assert.equal(groups[1].sameAdvertiser, false);
  assert.equal(groups[1].listings[0].advertiserType, 'agency');
  assert.equal(groups[1].listings[0].commission, true);
  assert.equal(groups[2].listings[0].advertiserType, 'unknown');
  assert.equal(groups[2].contact, null);
  assert.ok(!JSON.stringify(groups).includes('verified'));
});

test('Telegram case variants group, arbitrary text does not become a shared contact', () => {
  const groups = groupDuplicateListings([
    listing(1, {data: {contact: '@OwnerName'}}), listing(2, {data: {contact: '@ownername'}}),
    listing(3, {data: {contact: 'call me'}}), listing(4, {data: {contact: 'call me'}}),
  ], 1);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].listings.length, 2);
});

test('a default byAgency=false is not an explicit owner claim', () => {
  const groups = groupDuplicateListings([listing(1, {data: {byAgency: false}})], 1);
  assert.equal(groups[0].listings[0].advertiserType, 'unknown');
});

test('publication refresh, reappearance and repost remain distinct events', () => {
  const events = snapshotEvents([
    {id: '1', changed: ['publication', 'price'], lifecycle_state: 'active', price: 0, currency: 'USD'},
    {id: '2', changed: ['lifecycle'], lifecycle_state: 'reappeared'},
    {id: '3', changed: ['published'], is_repost: true, lifecycle_state: 'published'},
    {id: '4', changed: ['published'], lifecycle_state: 'published'},
  ]);
  assert.deepEqual(events.map((e) => e.kind), ['date_updated', 'price_changed', 'reappeared', 'reposted']);
  assert.equal(events[1].price, 0);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});

test('history pagination keeps bigint cursor precision and does not lose simultaneous changes', async () => {
  const calls = [];
  const client = {query: async (sql, params) => {
    calls.push({sql, params});
    if (calls.length === 1) return {rows: [{first_seen_at: '2026-01-01', history_ids: ['10', '11']}]};
    return {rows: [
      {id: '9007199254740995', changed: ['publication', 'price'], lifecycle_state: 'active'},
      {id: '9007199254740994', changed: ['contact'], lifecycle_state: 'active'},
    ]};
  }};
  const result = await readListingActivity(10, {limit: 1, before: '9007199254740996'}, client);
  assert.equal(result.events.length, 2);
  assert.equal(result.nextCursor, '9007199254740995');
  assert.equal(calls[1].params[1], '9007199254740996');
  assert.deepEqual(calls[1].params[0], ['10', '11']);
});

test('summary loads a page in one query and does not query for an empty page', async () => {
  let count = 0;
  const client = {query: async () => {count++; return {rows: [{id: 1, first_seen_at: '2026-01-01', duplicate_count: 2, date_update_count: 3}]};}};
  assert.equal((await loadActivitySummaries([], client)).size, 0);
  const summary = await loadActivitySummaries([1,2,3], client);
  assert.equal(count, 1);
  assert.equal(summary.get(1).duplicateCount, 2);
});
