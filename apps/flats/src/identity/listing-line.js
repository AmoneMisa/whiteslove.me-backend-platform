import { resolveIntegrityScores } from './integrity-scores.js';

/**
 * The coloured line on a listing card.
 *
 * One of four, and every one describes the listing and its advertising
 * behaviour, never a verdict about a person (§35; operator decision: listing
 * wording, no human review):
 *
 *   steady        green   long, clean, consistent advertising history
 *   phantom_risk  red     strong phantom / clone pattern across properties
 *   multi_listing purple  the contact advertises other properties too
 *   null          grey    nothing to say
 *
 * Two exclusions are load-bearing:
 *  - Legacy Google-registry labels never colour a card. They are imported as
 *    internal evidence only, and publishing the operator's old blacklist as a
 *    red line is exactly what the plan forbids.
 *  - Evidence under dispute, and subjects who restricted or objected to
 *    processing, produce no line at all.
 */

// There is no yellow "worth checking" line: the operator removed it as
// unnecessary. Evidence that would have produced it still blocks green.
export const LISTING_LINES = Object.freeze(['steady', 'phantom_risk', 'multi_listing']);

/** Distinct properties the evidence must span before red is shown. One flat
 * that rented fast, or one copied listing, is not a pattern. */
export const PHANTOM_MIN_PROPERTIES = 3;
/** Red needs availability credibility at or below this... */
export const PHANTOM_MAX_CREDIBILITY = 0.3;
/** ...or provenance risk at or above this. */
export const PHANTOM_MIN_PROVENANCE_RISK = 0.7;
/** Independent observations of clean behaviour before green is shown. */
export const STEADY_MIN_OBSERVATIONS = 5;

const PHANTOM_REASONS = new Set([
  'phantom_unavailable_inventory',
  'alternative_after_unavailable',
  'repeated_fresh_relisting',
  'copied_inventory',
  'likely_cloned_listing',
]);

const STEADY_REASONS = new Set(['stable_identity', 'no_phantom_repost_behaviour', 'consistent_property_facts', 'listing_removed_after_rental']);

const isLegacy = (row) => String(row?.reasonCode ?? '').startsWith('legacy_registry_');

/**
 * `input`: `{ evidence, otherProperties, restricted, now }` for the listing's
 * contact. Returns `{ line, reasons }`; reasons are codes for tests and logs,
 * not for display.
 */
export function resolveListingLine(input = {}) {
  if (input.restricted) return Object.freeze({ line: null, reasons: Object.freeze(['processing_restricted']) });

  const evidence = (input.evidence ?? []).filter((row) => row
    && !isLegacy(row)
    && row.underDispute !== true
    && !['dismissed', 'resolved'].includes(row.reviewState ?? 'open'));
  const options = input.now ? { now: input.now } : {};
  const result = resolveIntegrityScores(evidence, options);
  const { availabilityCredibility, provenanceRisk } = result.scores;

  const phantomRows = evidence.filter((row) => row.polarity === 'risk' && PHANTOM_REASONS.has(row.reasonCode));
  const phantomProperties = phantomRows.reduce((max, row) => Math.max(max, Number(row.independentCount) || 0), 0);
  const phantomScore = (availabilityCredibility !== null && availabilityCredibility <= PHANTOM_MAX_CREDIBILITY)
    || (provenanceRisk !== null && provenanceRisk >= PHANTOM_MIN_PROVENANCE_RISK);
  if (phantomScore && phantomProperties >= PHANTOM_MIN_PROPERTIES) {
    return Object.freeze({ line: 'phantom_risk', reasons: Object.freeze(phantomRows.map((row) => row.reasonCode)) });
  }

  const hasRisk = evidence.some((row) => row.polarity === 'risk');
  const steadyRows = evidence.filter((row) => row.polarity === 'trust' && STEADY_REASONS.has(row.reasonCode));
  const steadyObservations = steadyRows.reduce((max, row) => Math.max(max, Number(row.independentCount) || 0), 0);
  if (!hasRisk && steadyObservations >= STEADY_MIN_OBSERVATIONS) {
    return Object.freeze({ line: 'steady', reasons: Object.freeze(steadyRows.map((row) => row.reasonCode)) });
  }

  if (Number(input.otherProperties) > 0) {
    return Object.freeze({ line: 'multi_listing', reasons: Object.freeze(['contact_has_other_listings']) });
  }

  return Object.freeze({ line: null, reasons: Object.freeze([]) });
}
