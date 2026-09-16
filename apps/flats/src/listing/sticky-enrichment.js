import { createProvenance, shouldReplaceProvenance } from '@whiteslove/parsing-lexicon/provenance';

/**
 * Keeps hard-won enrichment when a later scrape simply fails to mention it.
 *
 * Re-scraping a listing is not a fresh statement of everything about it. A
 * source page can render without its map block, drop the residential-complex
 * label, or return a shortened description, and a plain overwrite then erases
 * a canonical geo match or a resolved owner identity that took an enrichment
 * pass and an AI call to establish.
 *
 * The rule is asymmetric on purpose: a fresh *authoritative* value replaces an
 * old one, but fresh *absence* never erases a trusted one. Absence is not
 * evidence -- the scrape did not say the flat has no metro, it just did not
 * say anything.
 */

/** Fields expensive to establish and routinely missing from a re-scrape. */
export const STICKY_FIELDS = Object.freeze([
  'canonicalCity',
  'canonicalDistrict',
  'district',
  'metro',
  'metroDistanceMinutes',
  'residenceComplex',
  'lat',
  'lng',
  'addressStreet',
  'addressHouseNumber',
  'ownerEvidence',
  'agencyEvidence',
  'phoneIdentity',
  'availableFrom',
]);

/** After this, a sticky value is reported stale: still kept, but flagged so a
 * caller can choose to re-derive rather than trust it indefinitely. */
export const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const blank = (value) => value === null || value === undefined || value === ''
  || (Array.isArray(value) && value.length === 0);

const timeOf = (value) => {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/**
 * Merges one field.
 *
 * `previous`/`incoming` are `{ value, provenance }`. Returns the winner plus
 * why, so the decision is auditable rather than silent.
 */
export function mergeStickyField(previous, incoming, options = {}) {
  const now = options.now ? timeOf(options.now) : Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const hadValue = previous && !blank(previous.value);
  const hasValue = incoming && !blank(incoming.value);

  if (!hadValue && !hasValue) return decision(null, 'both_absent', { now, staleAfterMs });
  if (!hadValue) return decision(incoming, 'first_observation', { now, staleAfterMs });
  // The whole point: a re-scrape that says nothing must not erase what we know.
  if (!hasValue) return decision(previous, 'kept_absent_incoming', { now, staleAfterMs, sticky: true });

  // Both sides have a value, so the shared provenance ordering decides: a
  // stronger tier wins, and within a tier the more recent observation does.
  // That already covers "the source updated its own value", so there is no
  // separate same-tier rule here to drift out of step with the lexicon.
  return shouldReplaceProvenance(previous.provenance, incoming.provenance)
    ? decision(incoming, 'fresh_authoritative', { now, staleAfterMs })
    : decision(previous, 'kept_stronger_existing', { now, staleAfterMs, sticky: true });
}

function decision(chosen, reason, { now, staleAfterMs, sticky = false }) {
  if (!chosen) return Object.freeze({ value: null, provenance: null, reason, sticky: false, stale: false });
  const observedAt = timeOf(chosen.provenance?.observedAt);
  const ageMs = observedAt === null ? null : Math.max(0, now - observedAt);
  return Object.freeze({
    value: chosen.value,
    provenance: chosen.provenance ?? null,
    reason,
    sticky,
    ageMs,
    stale: ageMs !== null && ageMs > staleAfterMs,
  });
}

/**
 * Merges a whole listing's sticky fields.
 *
 * Non-sticky fields are left to the caller's ordinary overwrite path; only the
 * expensive ones defended here are protected from absence.
 */
export function mergeStickyEnrichment(previous = {}, incoming = {}, options = {}) {
  const fields = options.fields ?? STICKY_FIELDS;
  const previousProvenance = previous.fieldProvenance ?? {};
  const incomingProvenance = incoming.fieldProvenance ?? {};
  const merged = { ...incoming };
  const provenance = { ...incomingProvenance };
  const decisions = {};

  for (const field of fields) {
    const result = mergeStickyField(
      { value: previous[field], provenance: previousProvenance[field] },
      { value: incoming[field], provenance: incomingProvenance[field] },
      options,
    );
    decisions[field] = result;
    if (result.value === null && blank(incoming[field]) && blank(previous[field])) continue;
    merged[field] = result.value;
    if (result.provenance) provenance[field] = result.provenance;
  }

  merged.fieldProvenance = Object.freeze({ ...previousProvenance, ...provenance });
  merged.stickyDecisions = Object.freeze(decisions);
  return merged;
}

/** Convenience for recording a value observed now at a given tier. */
export function observed(value, source, parser, now = new Date()) {
  return {
    value,
    provenance: createProvenance({
      source,
      ...(parser ? { parser } : {}),
      observedAt: now instanceof Date ? now.toISOString() : String(now),
    }),
  };
}
