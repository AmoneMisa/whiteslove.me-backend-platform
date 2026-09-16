import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildListingSnapshot, diffSnapshots, planSnapshotAppend,
  contentHashOf, mediaHashOf, priceDelta,
} from '../src/listing/listing-snapshots.js';
import {
  summarizeAvailability, buildBaitAndSwitchGraph, summarizeRepostCycles,
  FRESH_WINDOW_MS, AVAILABILITY_THRESHOLDS,
} from '../src/listing/availability-metrics.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-03-01T00:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

const listing = (extra = {}) => ({
  id: 1, source: 'olx', country: 'UZ', sourceId: 'abc',
  title: 'Сдам квартиру', description: 'Хорошая квартира', price: 500, currency: 'USD',
  active: true, ...extra,
});

const snapshotOf = (extra, options) => buildListingSnapshot(listing(extra), { observedAt: NOW, ...options });

// --- snapshot identity ------------------------------------------------------

test('a snapshot carries what history needs and nothing more', () => {
  const snapshot = snapshotOf();
  assert.equal(snapshot.source, 'olx');
  assert.equal(snapshot.country, 'UZ');
  assert.equal(snapshot.price, 500);
  assert.ok(snapshot.contentHash, 'content is hashed, not copied');
  assert.equal(snapshot.title, undefined, 'the text itself is not duplicated into history');
  assert.equal(snapshot.description, undefined);
});

test('a listing without its identifying triple yields no snapshot', () => {
  assert.equal(buildListingSnapshot({ title: 'x' }), null);
  assert.equal(buildListingSnapshot(null), null);
});

test('reflowed whitespace is not a content change', () => {
  assert.equal(contentHashOf({ title: 'Сдам  квартиру', description: 'A\n\nB' }), contentHashOf({ title: 'Сдам квартиру', description: 'A B' }));
});

test('media identity is the set of photos, not their order', () => {
  assert.equal(mediaHashOf({ photoHashes: ['a', 'b'] }), mediaHashOf({ photoHashes: ['b', 'a'] }));
  assert.notEqual(mediaHashOf({ photoHashes: ['a', 'b'] }), mediaHashOf({ photoHashes: ['a', 'c'] }));
  assert.equal(mediaHashOf({ photoHashes: [] }), null);
});

test('a duplicated photo does not change media identity', () => {
  assert.equal(mediaHashOf({ photoHashes: ['a', 'a', 'b'] }), mediaHashOf({ photoHashes: ['a', 'b'] }));
});

// --- the append gate --------------------------------------------------------

test('an unchanged re-crawl appends nothing', () => {
  // The cost decision: a row per listing per crawl would dwarf the listings
  // table within weeks.
  const previous = snapshotOf();
  const plan = planSnapshotAppend(previous, snapshotOf({}, { observedAt: new Date(NOW.getTime() + HOUR) }));
  assert.equal(plan.append, false);
  assert.equal(plan.reason, 'unchanged');
});

test('a first observation is always appended as published', () => {
  const plan = planSnapshotAppend(null, snapshotOf());
  assert.equal(plan.append, true);
  assert.equal(plan.snapshot.lifecycleState, 'published');
  assert.deepEqual(plan.snapshot.changed, ['published']);
});

test('a price change is appended and names what changed', () => {
  const plan = planSnapshotAppend(snapshotOf(), snapshotOf({ price: 550 }));
  assert.equal(plan.append, true);
  assert.deepEqual(plan.snapshot.changed, ['price']);
  assert.equal(plan.snapshot.price, 550);
});

test('content, media and contact changes are each detected', () => {
  assert.deepEqual(diffSnapshots(snapshotOf(), snapshotOf({ description: 'Другое описание' })), ['content']);
  assert.deepEqual(diffSnapshots(snapshotOf({ photoHashes: ['a'] }), snapshotOf({ photoHashes: ['b'] })), ['media']);
  assert.deepEqual(diffSnapshots(snapshotOf({}, { contactPointId: 1 }), snapshotOf({}, { contactPointId: 2 })), ['contact']);
});

test('a listing seen again after removal is reappeared, not merely active', () => {
  // Collapsing this into "active" would erase the repost signal entirely.
  const removed = snapshotOf({ active: false });
  const plan = planSnapshotAppend(removed, snapshotOf({ active: true }));
  assert.equal(plan.append, true);
  assert.equal(plan.reason, 'reappeared');
  assert.equal(plan.snapshot.lifecycleState, 'reappeared');
});

test('a reappearance does not collide with the earlier active snapshot', () => {
  // The dedupe index is on (source, country, source_id, snapshot_hash), so a
  // reappearance whose hash matched the old active row would be dropped.
  const published = planSnapshotAppend(null, snapshotOf()).snapshot;
  const removed = planSnapshotAppend(published, snapshotOf({ active: false })).snapshot;
  const reappeared = planSnapshotAppend(removed, snapshotOf({ active: true })).snapshot;
  assert.notEqual(reappeared.snapshotHash, published.snapshotHash, 'or the reappearance would be silently lost');
});

test('price movement is only comparable within one currency', () => {
  assert.equal(priceDelta({ price: 500, currency: 'USD' }, { price: 550, currency: 'USD' }).ratio, 1.1);
  assert.equal(priceDelta({ price: 500, currency: 'USD' }, { price: 550, currency: 'UZS' }).comparable, false);
  assert.equal(priceDelta({ price: 0, currency: 'USD' }, { price: 5, currency: 'USD' }), null);
  assert.equal(priceDelta(null, null), null);
});

// --- availability (§30) -----------------------------------------------------

const seen = (sourceId, status, hoursAfterPublish, daysAgo, extra = {}) => ({
  source: 'olx', country: 'UZ', sourceId,
  status,
  publishedAt: ago(daysAgo * DAY + hoursAfterPublish * HOUR),
  observedAt: ago(daysAgo * DAY),
  ...extra,
});

test('one fast rental is not evidence of anything', () => {
  // An honest advertiser whose flat goes the same day looks identical to a
  // phantom on a single observation.
  const summary = summarizeAvailability([seen('a', 'already_rented', 2, 1)], { now: NOW });
  assert.deepEqual(summary.reasons, []);
  assert.equal(summary.independentEvidenceCount, 1);
});

test('repeated reports on one flat stay one property of evidence', () => {
  const summary = summarizeAvailability([
    seen('a', 'already_rented', 2, 5),
    seen('a', 'already_rented', 2, 4),
    seen('a', 'offered_alternative', 2, 3, { alternativeSourceId: 'z' }),
    seen('a', 'already_rented', 2, 2),
  ], { now: NOW });
  assert.equal(summary.independentEvidenceCount, 1, 'ten reports on one listing are not ten properties');
  assert.deepEqual(summary.reasons, []);
});

test('the same pattern across independent properties is evidence', () => {
  const summary = summarizeAvailability([
    seen('a', 'already_rented', 2, 5),
    seen('b', 'already_rented', 3, 4),
    seen('c', 'offered_alternative', 1, 3, { alternativeSourceId: 'z' }),
  ], { now: NOW });
  assert.ok(summary.reasons.includes('fresh_listing_immediately_unavailable'));
  assert.ok(summary.reasons.includes('phantom_unavailable_inventory'));
  assert.equal(summary.independentEvidenceCount, 3);
});

test('an actor whose listings are genuinely available produces no reasons', () => {
  const summary = summarizeAvailability([
    seen('a', 'available', 2, 5),
    seen('b', 'viewing_available', 3, 4),
    seen('c', 'available', 1, 3),
  ], { now: NOW });
  assert.deepEqual(summary.reasons, []);
  assert.equal(summary.freshUnavailableRate, 0);
});

test('unavailability long after publication is not "fresh"', () => {
  const summary = summarizeAvailability([
    seen('a', 'already_rented', 24 * 10, 5),
    seen('b', 'already_rented', 24 * 12, 4),
    seen('c', 'already_rented', 24 * 15, 3),
  ], { now: NOW });
  assert.equal(summary.freshUnavailableRate, 0, 'a flat rented after ten days is a flat that rented');
  assert.ok(!summary.reasons.includes('fresh_listing_immediately_unavailable'));
  assert.ok(FRESH_WINDOW_MS < 2 * DAY);
});

test('a steering pattern is reported separately from unavailability', () => {
  const summary = summarizeAvailability([
    seen('a', 'offered_alternative', 1, 5, { alternativeSourceId: 'x' }),
    seen('b', 'offered_alternative', 1, 4, { alternativeSourceId: 'y' }),
    seen('c', 'offered_alternative', 1, 3, { alternativeSourceId: 'z' }),
  ], { now: NOW });
  assert.ok(summary.reasons.includes('alternative_after_unavailable'));
  assert.equal(summary.alternativeAfterUnavailableRate, 1);
});

test('observations outside the window are excluded', () => {
  const summary = summarizeAvailability([seen('a', 'already_rented', 2, 200)], { now: NOW, windowDays: 90 });
  assert.equal(summary.observationCount, 0);
});

test('empty and malformed input produce an empty summary', () => {
  assert.equal(summarizeAvailability([], { now: NOW }).observationCount, 0);
  assert.equal(summarizeAvailability(null, { now: NOW }).propertyCount, 0);
  assert.equal(summarizeAvailability([{ status: 'available' }], { now: NOW }).observationCount, 0);
});

test('availability output states plainly that it is evidence', () => {
  assert.equal(summarizeAvailability([seen('a', 'available', 1, 1)], { now: NOW }).evidenceOnly, true);
  assert.ok(AVAILABILITY_THRESHOLDS.independentProperties >= 3, 'a single property must never trigger a reason');
});

// --- bait and switch (§31) --------------------------------------------------

test('the graph counts independent bait properties, not edges', () => {
  const graph = buildBaitAndSwitchGraph([
    seen('a', 'offered_alternative', 1, 3, { alternativeSourceId: 'z' }),
    seen('a', 'offered_alternative', 1, 2, { alternativeSourceId: 'z' }),
    seen('b', 'offered_alternative', 1, 1, { alternativeSourceId: 'z' }),
  ]);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.independentBaitPropertyCount, 2, 'evidence across properties is what counts');
  assert.equal(graph.distinctAlternatives, 1, 'every enquiry steered to the same flat');
});

test('an alternative offered without an unavailability is not a bait edge', () => {
  const graph = buildBaitAndSwitchGraph([seen('a', 'available', 1, 1, { alternativeSourceId: 'z' })]);
  assert.deepEqual(graph.edges, []);
});

// --- repost cycles (§29) ----------------------------------------------------

const cycle = (state, daysAgo) => ({ lifecycleState: state, observedAt: ago(daysAgo * DAY) });

test('a publish-remove-republish loop is counted', () => {
  const summary = summarizeRepostCycles([
    cycle('published', 30), cycle('removed', 28),
    cycle('reappeared', 20), cycle('removed', 18),
    cycle('reappeared', 10), cycle('removed', 8),
    cycle('reappeared', 2),
  ], { now: NOW });
  assert.equal(summary.repostCount30d, 3);
  assert.ok(summary.reasons.includes('repeated_fresh_relisting'));
  assert.ok(summary.medianListingLifetimeMs > 0);
  assert.ok(summary.medianRepostIntervalMs > 0);
});

test('a single relisting is not a pattern', () => {
  const summary = summarizeRepostCycles([
    cycle('published', 30), cycle('removed', 20), cycle('reappeared', 10),
  ], { now: NOW });
  assert.equal(summary.repostCount30d, 1);
  assert.deepEqual(summary.reasons, [], 'sellers relist; that is not laundering');
});

test('a listing that simply stays up has no repost history', () => {
  const summary = summarizeRepostCycles([cycle('published', 40), cycle('active', 5)], { now: NOW });
  assert.equal(summary.repostCount30d, 0);
  assert.equal(summary.medianRepostIntervalMs, null);
});

test('empty repost input does not throw', () => {
  assert.equal(summarizeRepostCycles([], { now: NOW }).repostCount24h, 0);
  assert.equal(summarizeRepostCycles(null, { now: NOW }).medianListingLifetimeMs, null);
});
