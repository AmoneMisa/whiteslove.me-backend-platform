import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLineage, detectOriginalDisappearance, detectConcurrentRentalClaims,
  LINEAGE_RELATIONS,
} from '../src/listing/listing-lineage.js';
import { scoreCloneRelationship } from '../src/listing/photo-antifake.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T00:00:00.000Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

const listing = (extra = {}) => ({
  source: 'olx', country: 'UZ', sourceId: 'a',
  title: 'Сдам 2-комнатную квартиру', price: 500, currency: 'USD',
  rooms: 2, areaSqm: 60, city: 'Tashkent', district: 'Chilonzor',
  byAgency: false, createdAt: ago(10), ...extra,
});

/** The real scorer, so lineage is tested against what actually feeds it. */
const relate = (current, matched, evidence = { matchType: 'exact' }) => scoreCloneRelationship(current, matched, evidence);

test('the relation vocabulary is the one the plan defines', () => {
  assert.deepEqual([...LINEAGE_RELATIONS], ['possible_original', 'likely_derived', 'cross_post', 'repost', 'undetermined']);
});

test('an earlier timestamp alone never establishes an original', () => {
  // The rule §26 states outright. Crawl timing is not publication timing: a
  // source polled hourly always looks earlier than one polled daily.
  const current = listing({ createdAt: ago(20) });
  const matched = { ...listing({ sourceId: 'b', createdAt: ago(1) }), created_at: ago(1), by_agency: false };
  const lineage = classifyLineage(current, matched, relate(current, matched), { sameContact: null });
  assert.notEqual(lineage.relation, 'possible_original');
  assert.equal(lineage.relation, 'undetermined');
});

test('a later copy with a seller conflict is a derivation', () => {
  const current = listing({ sourceId: 'copy', createdAt: ago(1), byAgency: true, price: 600 });
  const matched = { ...listing({ sourceId: 'orig' }), created_at: ago(20), by_agency: false, area_sqm: 60 };
  const lineage = classifyLineage(current, matched, relate(current, matched), { sameContact: false });
  assert.equal(lineage.relation, 'likely_derived');
  assert.ok(lineage.reasonCodes.includes('likely_cloned_listing'));
});

test('an agency copying an owner and raising the price is flagged as markup', () => {
  const current = listing({ sourceId: 'copy', createdAt: ago(1), byAgency: true, price: 700 });
  const matched = { ...listing({ sourceId: 'orig' }), created_at: ago(20), by_agency: false, price: 500, area_sqm: 60 };
  const lineage = classifyLineage(current, matched, relate(current, matched), { sameContact: false });
  assert.equal(lineage.relation, 'likely_derived');
  assert.ok(lineage.reasonCodes.includes('derived_listing_price_markup'));
  assert.ok(lineage.priceDeltaPct > 0);
});

test('the same advertiser on the same site is a repost, not a clone', () => {
  const current = listing({ sourceId: 'new', createdAt: ago(1) });
  const matched = { ...listing({ sourceId: 'old' }), created_at: ago(20), by_agency: false, area_sqm: 60 };
  const lineage = classifyLineage(current, matched, relate(current, matched), { sameContact: true, sameSource: true });
  assert.equal(lineage.relation, 'repost');
  assert.ok(!lineage.reasonCodes.includes('likely_cloned_listing'));
});

test('the same advertiser on a different site is an ordinary cross-post', () => {
  // Cross-posting is normal behaviour and must never be reported as a clone.
  const current = listing({ source: 'telegram', sourceId: 'x', createdAt: ago(1) });
  const matched = { ...listing({ sourceId: 'y' }), source: 'olx', created_at: ago(20), by_agency: false, area_sqm: 60 };
  const lineage = classifyLineage(current, matched, relate(current, matched), { sameContact: true, sameSource: false });
  assert.equal(lineage.relation, 'cross_post');
});

test('shared photos with nothing contradictory is not a finding', () => {
  const current = listing({ sourceId: 'a', createdAt: ago(1) });
  const matched = { ...listing({ sourceId: 'b' }), created_at: ago(20), by_agency: false, area_sqm: 60 };
  const lineage = classifyLineage(current, matched, relate(current, matched), { sameContact: null });
  assert.equal(lineage.relation, 'undetermined');
  assert.ok(['insufficient_evidence', 'earlier_but_uncorroborated', 'conflicting_but_chronology_unclear'].includes(lineage.undeterminedReason));
});

test('an original is claimed only with corroboration beyond being earlier', () => {
  // The counterpart is the later copy AND the facts agree, so this side may be
  // the original. Chronology alone would not have been enough.
  const current = listing({ sourceId: 'orig', createdAt: ago(20), byAgency: false });
  const matched = { ...listing({ sourceId: 'copy' }), created_at: ago(1), by_agency: true, price: 700, area_sqm: 60 };
  const lineage = classifyLineage(current, matched, relate(current, matched), { sameContact: false });
  assert.ok(['possible_original', 'undetermined'].includes(lineage.relation));
  if (lineage.relation === 'possible_original') {
    assert.ok(lineage.evidence.includes('counterpart_is_later_copy'));
  }
});

test('lineage output is marked as evidence, never a verdict', () => {
  const current = listing();
  const matched = { ...listing({ sourceId: 'b' }), created_at: ago(20), by_agency: false };
  assert.equal(classifyLineage(current, matched, relate(current, matched)).evidenceOnly, true);
});

test('a missing relation analysis yields undetermined rather than throwing', () => {
  const lineage = classifyLineage(listing(), listing(), null);
  assert.equal(lineage.relation, 'undetermined');
  assert.equal(lineage.undeterminedReason, 'no_relation_analysis');
});

// --- post-copy disappearance (§27) ------------------------------------------

test('an original removed shortly after being copied is flagged', () => {
  const result = detectOriginalDisappearance({
    derivedFirstSeenAt: ago(5),
    originalRemovedAt: ago(3),
    derivedStillActive: true,
  });
  assert.equal(result.detected, true);
  assert.equal(result.reasonCode, 'post_copy_original_disappearance');
});

test('an original removed before the copy appeared is just a flat that rented', () => {
  // By far the common, innocent explanation, and it must not be reported.
  const result = detectOriginalDisappearance({
    derivedFirstSeenAt: ago(3),
    originalRemovedAt: ago(10),
    derivedStillActive: true,
  });
  assert.equal(result.detected, false);
  assert.equal(result.reason, 'original_removed_before_copy');
});

test('a removal long after the copy is not related to it', () => {
  const result = detectOriginalDisappearance({
    derivedFirstSeenAt: ago(60),
    originalRemovedAt: ago(1),
    derivedStillActive: true,
  });
  assert.equal(result.detected, false);
  assert.equal(result.reason, 'removal_too_late_to_relate');
});

test('both listings disappearing is not the pattern', () => {
  const result = detectOriginalDisappearance({
    derivedFirstSeenAt: ago(5), originalRemovedAt: ago(3), derivedStillActive: false,
  });
  assert.equal(result.detected, false);
  assert.equal(result.reason, 'copy_also_gone');
});

test('missing history reports insufficient rather than guessing', () => {
  assert.equal(detectOriginalDisappearance({}).detected, false);
  assert.equal(detectOriginalDisappearance({ derivedFirstSeenAt: ago(1) }).reason, 'insufficient_history');
});

// --- concurrent claims (§27) ------------------------------------------------

test('several unrelated actors advertising one flat is a finding', () => {
  const result = detectConcurrentRentalClaims([
    { actorId: 1 }, { actorId: 2 }, { actorId: 3 },
  ]);
  assert.equal(result.detected, true);
  assert.equal(result.reasonCode, 'multiple_concurrent_rental_claims');
});

test('one actor cross-posting to four sites is one claim', () => {
  const result = detectConcurrentRentalClaims([
    { actorId: 7 }, { actorId: 7 }, { actorId: 7 }, { actorId: 7 },
  ]);
  assert.equal(result.detected, false);
  assert.equal(result.distinctActors, 1);
});

test('inactive listings and unknown actors do not count', () => {
  const result = detectConcurrentRentalClaims([
    { actorId: 1 }, { actorId: 2, active: false }, { actorId: null }, {},
  ]);
  assert.equal(result.distinctActors, 1);
  assert.equal(result.detected, false);
  assert.equal(detectConcurrentRentalClaims([]).detected, false);
  assert.equal(detectConcurrentRentalClaims(null).distinctActors, 0);
});
