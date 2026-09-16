import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STICKY_FIELDS, DEFAULT_STALE_AFTER_MS,
  mergeStickyField, mergeStickyEnrichment, observed,
} from '../src/listing/sticky-enrichment.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-01T00:00:00.000Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY);
const merge = (previous, incoming) => mergeStickyField(previous, incoming, { now: NOW });

test('the sticky field list covers the expensive enrichments', () => {
  for (const field of ['canonicalCity', 'metro', 'metroDistanceMinutes', 'residenceComplex', 'lat', 'lng', 'ownerEvidence', 'phoneIdentity', 'availableFrom']) {
    assert.ok(STICKY_FIELDS.includes(field), field);
  }
});

test('a first observation is simply taken', () => {
  const result = merge({ value: null }, observed('Chilonzor', 'description', 'geo', daysAgo(0)));
  assert.equal(result.value, 'Chilonzor');
  assert.equal(result.reason, 'first_observation');
  assert.equal(result.sticky, false);
});

test('a re-scrape that says nothing does not erase what we know', () => {
  // The failure this exists to prevent: a source page renders without its map
  // block and a resolved canonical geo match is wiped.
  const previous = observed('Chilonzor', 'description', 'geo', daysAgo(3));
  const result = merge(previous, { value: null });
  assert.equal(result.value, 'Chilonzor');
  assert.equal(result.reason, 'kept_absent_incoming');
  assert.equal(result.sticky, true);
});

test('every kind of absence is treated as absence', () => {
  const previous = observed('Chilonzor', 'description', 'geo', daysAgo(1));
  for (const empty of [null, undefined, '', []]) {
    assert.equal(merge(previous, { value: empty }).value, 'Chilonzor', JSON.stringify(empty));
  }
});

test('a fresh authoritative value replaces a weaker old one', () => {
  const previous = observed('Chilonzor', 'ai_enrichment', 'ai.apartment', daysAgo(10));
  const incoming = observed('Yunusobod', 'structured_api', null, daysAgo(0));
  const result = merge(previous, incoming);
  assert.equal(result.value, 'Yunusobod');
  assert.equal(result.reason, 'fresh_authoritative');
});

test('a weaker fresh value does not replace a stronger old one', () => {
  const previous = observed('Chilonzor', 'structured_api', null, daysAgo(40));
  const incoming = observed('Yunusobod', 'ai_enrichment', 'ai.apartment', daysAgo(0));
  const result = merge(previous, incoming);
  assert.equal(result.value, 'Chilonzor', 'AI must not overwrite a structured value even when newer');
  assert.equal(result.reason, 'kept_stronger_existing');
});

test('a changed value from the same tier is taken as an update', () => {
  // Within a tier the shared provenance ordering breaks the tie on recency,
  // so a source updating its own value is picked up rather than pinned.
  const previous = observed(500, 'structured_api', null, daysAgo(10));
  const incoming = observed(550, 'structured_api', null, daysAgo(0));
  const result = merge(previous, incoming);
  assert.equal(result.value, 550, 'the source genuinely changed; do not pin the first observation forever');
  assert.equal(result.reason, 'fresh_authoritative');
});

test('an older same-tier observation does not overwrite a newer one', () => {
  const previous = observed(550, 'structured_api', null, daysAgo(1));
  const incoming = observed(500, 'structured_api', null, daysAgo(10));
  assert.equal(merge(previous, incoming).value, 550);
});

test('a re-observation of the same value refreshes rather than ages', () => {
  const previous = observed('Chilonzor', 'structured_api', null, daysAgo(40));
  const result = merge(previous, observed('Chilonzor', 'structured_api', null, daysAgo(0)));
  assert.equal(result.value, 'Chilonzor');
  assert.equal(result.stale, false, 'seeing it again resets the staleness clock');
  assert.ok(result.ageMs < DAY);
});

test('staleness is reported without discarding the value', () => {
  const fresh = merge(observed('Chilonzor', 'description', 'geo', daysAgo(5)), { value: null });
  assert.equal(fresh.stale, false);
  assert.ok(fresh.ageMs >= 5 * DAY);

  const old = merge(observed('Chilonzor', 'description', 'geo', daysAgo(45)), { value: null });
  assert.equal(old.stale, true, 'flagged for re-derivation');
  assert.equal(old.value, 'Chilonzor', 'but still kept');
  assert.ok(DEFAULT_STALE_AFTER_MS < 45 * DAY);
});

test('a value with no observation time is never called stale', () => {
  const result = merge({ value: 'Chilonzor', provenance: undefined }, { value: null });
  assert.equal(result.value, 'Chilonzor');
  assert.equal(result.stale, false);
  assert.equal(result.ageMs, null);
});

test('two absences stay absent', () => {
  const result = merge({ value: null }, { value: null });
  assert.equal(result.value, null);
  assert.equal(result.reason, 'both_absent');
});

test('a whole listing keeps its sticky fields through a thin re-scrape', () => {
  const previous = {
    canonicalCity: 'Tashkent', metro: 'Chilonzor', residenceComplex: 'Nest One',
    lat: 41.3, lng: 69.25, price: 500,
    fieldProvenance: {
      canonicalCity: observed('Tashkent', 'description', 'geo', daysAgo(2)).provenance,
      metro: observed('Chilonzor', 'description', 'geo', daysAgo(2)).provenance,
      residenceComplex: observed('Nest One', 'ai_enrichment', 'ai.apartment', daysAgo(2)).provenance,
    },
  };
  const thin = { price: 520, title: 'same flat, shorter page' };
  const merged = mergeStickyEnrichment(previous, thin, { now: NOW });

  assert.equal(merged.canonicalCity, 'Tashkent');
  assert.equal(merged.metro, 'Chilonzor');
  assert.equal(merged.residenceComplex, 'Nest One');
  assert.equal(merged.lat, 41.3);
  assert.equal(merged.price, 520, 'non-sticky fields still follow the ordinary overwrite path');
  assert.equal(merged.stickyDecisions.metro.sticky, true);
});

test('a fresher authoritative scrape does update the sticky fields', () => {
  const previous = {
    metro: 'Chilonzor',
    fieldProvenance: { metro: observed('Chilonzor', 'ai_enrichment', 'ai.apartment', daysAgo(20)).provenance },
  };
  const incoming = {
    metro: 'Novza',
    fieldProvenance: { metro: observed('Novza', 'structured_api', null, daysAgo(0)).provenance },
  };
  const merged = mergeStickyEnrichment(previous, incoming, { now: NOW });
  assert.equal(merged.metro, 'Novza');
  assert.equal(merged.stickyDecisions.metro.reason, 'fresh_authoritative');
});

test('merging empty records does not invent fields', () => {
  const merged = mergeStickyEnrichment({}, {}, { now: NOW });
  for (const field of STICKY_FIELDS) assert.ok(!(field in merged) || merged[field] === undefined, field);
  assert.deepEqual(merged.fieldProvenance, {});
});

test('the sticky field set can be narrowed by the caller', () => {
  const previous = { metro: 'Chilonzor', residenceComplex: 'Nest One' };
  const merged = mergeStickyEnrichment(previous, {}, { now: NOW, fields: ['metro'] });
  assert.equal(merged.metro, 'Chilonzor');
  assert.equal(merged.residenceComplex, undefined, 'a field outside the set is not defended');
});
