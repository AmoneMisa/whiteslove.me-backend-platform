/**
 * Multi-dimensional integrity scores (§34), public states (§35) and the
 * human-review gate (§36).
 *
 * There is deliberately no single fraud score. "This listing's availability is
 * doubtful" and "this actor asks for money before viewings" are different
 * claims with different evidence and different consequences, and summing them
 * would produce a number nobody could explain or contest.
 *
 * Every score is returned with the evidence rows that produced it and what
 * each contributed, so a reviewer -- or the person the evidence is about --
 * can see exactly why. Scores are evidence summaries, not probabilities and
 * not verdicts.
 */

export const DIMENSIONS = Object.freeze([
  'property_reality',
  'availability_credibility',
  'provenance_risk',
  'identity_risk',
  'payment_risk',
  'actor_behavior_risk',
]);

/** Dimensions where higher means better. Stored evidence is always framed as
 * risk or trust; these two are reported as 1 - risk so the name reads right. */
const POSITIVE_DIMENSIONS = new Set(['property_reality', 'availability_credibility']);

const CAMEL = Object.freeze({
  property_reality: 'propertyReality',
  availability_credibility: 'availabilityCredibility',
  provenance_risk: 'provenanceRisk',
  identity_risk: 'identityRisk',
  payment_risk: 'paymentRisk',
  actor_behavior_risk: 'actorBehaviorRisk',
});

/**
 * How much one reason weighs within its dimension. Unlisted reasons weigh 1.
 *
 * The low weights matter as much as the high ones. A legacy operator label is
 * an unexplained note from a spreadsheet and must not outweigh observed
 * behaviour; a single fast rental is how popular flats behave.
 */
export const REASON_WEIGHTS = Object.freeze({
  legacy_registry_risk: 0.35,
  legacy_registry_trust: 0.35,
  fresh_listing_immediately_unavailable: 0.4,
  viewing_fee_requested: 0.5,
  permanent_reposting: 0.4,
  payment_before_verification: 1.6,
  premature_identity_data_request: 1.6,
  application_fee_harvesting_pattern: 1.4,
  payment_destination_changed: 1.2,
  phantom_unavailable_inventory: 1.3,
  alternative_after_unavailable: 1.2,
  copied_inventory: 1.1,
});

/** Trust offsets risk at this rate. Below one on purpose: a long clean record
 * softens a finding but cannot erase a confirmed one. */
export const TRUST_OFFSET = 0.6;
/** Evidence not re-observed for this long counts half. */
export const STALE_AFTER_DAYS = 180;
/** Each further reason in a dimension counts this fraction of the previous
 * one, so ten weak reasons do not add up to one strong one. */
export const DIMINISHING = 0.5;

/** Review states that still count, and how much. Dismissed evidence counts for
 * nothing but stays in the breakdown, so a dismissal is visible, not silent. */
const REVIEW_FACTOR = Object.freeze({ open: 1, watch: 1, confirmed: 1.5, resolved: 0, dismissed: 0 });

const DAY_MS = 24 * 60 * 60 * 1000;
const round = (value) => Math.round(value * 1000) / 1000;

/** Saturating strength of independent evidence: 1 -> 0.5, 2 -> 0.75, 3 -> 0.875. */
export const independenceStrength = (count) => 1 - 0.5 ** Math.max(1, Math.floor(Number(count) || 1));

function contribution(row, now) {
  const reviewState = row.reviewState ?? 'open';
  const reviewFactor = REVIEW_FACTOR[reviewState] ?? 1;
  const weight = REASON_WEIGHTS[row.reasonCode] ?? 1;
  const seen = row.lastObservedAt ? Date.parse(row.lastObservedAt instanceof Date ? row.lastObservedAt.toISOString() : row.lastObservedAt) : NaN;
  const stale = Number.isFinite(seen) && now - seen > STALE_AFTER_DAYS * DAY_MS;
  return {
    reviewState,
    stale,
    value: weight * independenceStrength(row.independentCount) * reviewFactor * (stale ? 0.5 : 1),
  };
}

function mass(rows) {
  // Strongest first, each later one diminished, matching the parser's ledger.
  const sorted = [...rows].sort((left, right) => right.value - left.value);
  let total = 0;
  sorted.forEach((row, index) => { row.counted = round(row.value * DIMINISHING ** index); total += row.counted; });
  return total;
}

/**
 * Scores from evidence rows.
 *
 * `evidence` rows are `{ id?, polarity, reasonCode, dimension, independentCount,
 * reviewState?, lastObservedAt? }` -- the shape of platform.actor_evidence and
 * of the in-memory findings the earlier stages produce.
 *
 * A dimension with no evidence scores `null`, not zero. "Nothing known" and
 * "known to be clean" are different, and conflating them would present every
 * unknown advertiser as verified.
 */
export function resolveIntegrityScores(evidence, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const scores = {};
  const breakdown = {};

  for (const dimension of DIMENSIONS) {
    const rows = (evidence ?? []).filter((row) => row && row.dimension === dimension && (row.polarity === 'risk' || row.polarity === 'trust'));
    const entries = rows.map((row) => ({ id: row.id ?? null, polarity: row.polarity, reasonCode: row.reasonCode, independentCount: row.independentCount ?? 1, ...contribution(row, now) }));
    const risk = entries.filter((entry) => entry.polarity === 'risk');
    const trust = entries.filter((entry) => entry.polarity === 'trust');
    const riskMass = mass(risk);
    const trustMass = mass(trust);
    const counting = entries.filter((entry) => entry.value > 0);

    let score = null;
    if (counting.length) {
      const net = Math.max(0, riskMass - TRUST_OFFSET * trustMass);
      const riskScore = 1 - Math.exp(-net);
      score = round(POSITIVE_DIMENSIONS.has(dimension) ? 1 - riskScore : riskScore);
    }

    scores[CAMEL[dimension]] = score;
    breakdown[CAMEL[dimension]] = Object.freeze({
      score,
      riskMass: round(riskMass),
      trustMass: round(trustMass),
      // The widest independent support behind any counted reason. A max, not
      // a sum: one property reported under three reason codes is still one
      // property, and summing would count it three times.
      independentEvidence: counting.length ? Math.max(...counting.map((entry) => entry.independentCount)) : 0,
      reasons: Object.freeze(entries.map((entry) => Object.freeze({
        id: entry.id,
        polarity: entry.polarity,
        reasonCode: entry.reasonCode,
        independentCount: entry.independentCount,
        reviewState: entry.reviewState,
        stale: entry.stale,
        contribution: entry.counted ?? 0,
      }))),
    });
  }

  return Object.freeze({
    scores: Object.freeze(scores),
    breakdown: Object.freeze(breakdown),
    evidenceOnly: true,
    internalOnly: true,
  });
}

/** Threshold above which a dimension produces a public state. */
export const PUBLIC_STATE_THRESHOLD = 0.5;

/**
 * The minimal, defensible states a public page may show (§35).
 *
 * Only descriptions of the listing, never of a person: no identity or payment
 * risk ever reaches this, because "this advertiser may be a fraudster" is an
 * accusation an automated score cannot support. Those dimensions exist for
 * review only.
 */
export function publicIntegrityStates(result, evidence = []) {
  const states = [];
  const scores = result?.scores ?? {};
  const live = (evidence ?? []).filter((row) => row && !['dismissed', 'resolved'].includes(row.reviewState ?? 'open'));

  if (scores.availabilityCredibility !== null && scores.availabilityCredibility !== undefined && scores.availabilityCredibility <= 1 - PUBLIC_STATE_THRESHOLD) {
    states.push('listing_availability_uncertain');
  }
  if (live.some((row) => row.polarity === 'risk' && ['repeated_fresh_relisting', 'permanent_reposting'].includes(row.reasonCode))) {
    states.push('listing_appears_repeatedly');
  }
  if (scores.provenanceRisk !== null && scores.provenanceRisk !== undefined && scores.provenanceRisk >= PUBLIC_STATE_THRESHOLD) {
    states.push('source_information_inconsistent');
  }
  return Object.freeze(states);
}

/**
 * Consequences that must never follow from a score alone (§36). Each needs a
 * human decision recorded against the evidence first.
 */
export const HIGH_IMPACT_ACTIONS = Object.freeze([
  'public_blacklist',
  'remove_access',
  'hide_all_listings',
  'publish_allegation',
]);

/** Consequences cheap enough to take automatically, because they only route
 * something to a person or are trivially reversible. */
export const AUTOMATIC_ACTIONS = Object.freeze(['queue_for_review', 'show_public_state']);

/**
 * Whether an action may be taken. High-impact actions require at least one
 * piece of evidence a named reviewer has confirmed; no score is high enough to
 * stand in for that.
 */
export function authorizeIntegrityAction(action, evidence = []) {
  if (AUTOMATIC_ACTIONS.includes(action)) return Object.freeze({ allowed: true, requiresHumanReview: false });
  if (!HIGH_IMPACT_ACTIONS.includes(action)) return Object.freeze({ allowed: false, requiresHumanReview: true, reason: 'unknown_action' });
  const confirmed = (evidence ?? []).filter((row) => row?.polarity === 'risk' && row.reviewState === 'confirmed' && row.reviewedBy);
  return confirmed.length
    ? Object.freeze({ allowed: true, requiresHumanReview: true, confirmedEvidenceIds: Object.freeze(confirmed.map((row) => row.id ?? null)) })
    : Object.freeze({ allowed: false, requiresHumanReview: true, reason: 'no_confirmed_evidence' });
}

/**
 * Review actions (§36) as state transitions on one evidence row.
 *
 * approve -> confirmed, reject -> dismissed, watch -> watch, resolve ->
 * resolved (the matter is over, e.g. the listing was corrected), reopen ->
 * open. Approving and rejecting require a note: those are the decisions a
 * dispute will ask to see justified.
 */
export const REVIEW_TRANSITIONS = Object.freeze({
  approve: Object.freeze({ to: 'confirmed', from: Object.freeze(['open', 'watch']), noteRequired: true }),
  reject: Object.freeze({ to: 'dismissed', from: Object.freeze(['open', 'watch', 'confirmed']), noteRequired: true }),
  watch: Object.freeze({ to: 'watch', from: Object.freeze(['open']), noteRequired: false }),
  resolve: Object.freeze({ to: 'resolved', from: Object.freeze(['open', 'watch', 'confirmed']), noteRequired: false }),
  reopen: Object.freeze({ to: 'open', from: Object.freeze(['watch', 'confirmed', 'dismissed', 'resolved']), noteRequired: true }),
});

/** Validates a review action before it reaches the database. */
export function planReviewAction({ action, reviewer, note } = {}) {
  const transition = REVIEW_TRANSITIONS[action];
  if (!transition) return Object.freeze({ ok: false, error: 'unknown_action' });
  if (typeof reviewer !== 'string' || !reviewer.trim()) return Object.freeze({ ok: false, error: 'reviewer_required' });
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (transition.noteRequired && !trimmed) return Object.freeze({ ok: false, error: 'note_required' });
  if (trimmed.length > 2000) return Object.freeze({ ok: false, error: 'note_too_long' });
  return Object.freeze({ ok: true, action, to: transition.to, from: transition.from, reviewer: reviewer.trim(), note: trimmed || null });
}
