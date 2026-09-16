/**
 * How much a finished source scan is allowed to conclude.
 *
 * Reaching the last page of a chain means the crawler stopped, not that the
 * source was healthy. A site under maintenance, behind an anti-bot wall, or
 * quietly rate-limiting us returns a well-formed empty result page, the chain
 * terminates on page one, and the old reconciler deactivated every listing in
 * the scope on that evidence alone.
 *
 * Emptiness therefore has to be *earned*. A scan that sees nothing where
 * inventory is known to exist is suspect, not authoritative; only a run of
 * independent, otherwise-reliable empty scans confirms that the source really
 * is empty. Partial and failed scans never remove anything.
 */

export const SCAN_STATES = Object.freeze([
  'complete',         // terminated normally and saw listings
  'partial',          // stopped early: page cap, cutoff not reached, chain unfinished
  'failed',           // errored; says nothing about the inventory
  'suspect-empty',    // saw nothing, but the scope has known inventory
  'confirmed-empty',  // repeatedly and reliably saw nothing
]);

/** Consecutive suspect-empty scans before emptiness is believed. */
export const DEFAULT_EMPTY_CONFIRMATIONS = 3;
/** Suspect-empty scans closer together than this are not independent evidence:
 * a source outage lasting an hour would otherwise "confirm" emptiness by
 * itself just because the crawler ran three times during it. */
export const DEFAULT_MIN_CONFIRMATION_GAP_MS = 6 * 60 * 60 * 1000;

/** Only these two states may deactivate inventory. */
const REMOVING_STATES = new Set(['complete', 'confirmed-empty']);

export function isRemovingScanState(state) {
  return REMOVING_STATES.has(state);
}

/**
 * Classifies one finished scan.
 *
 * `priorEmptyRuns` are the previous consecutive suspect-empty runs for this
 * scope, newest first, each `{ observedAt }`. They are what turns repeated
 * emptiness into confirmed emptiness.
 */
export function classifyScanOutcome(input = {}) {
  const {
    observedCount = 0,
    knownActiveCount = 0,
    terminal = false,
    pageLimitReached = false,
    errored = false,
    priorEmptyRuns = [],
    observedAt = new Date(),
    emptyConfirmations = DEFAULT_EMPTY_CONFIRMATIONS,
    minConfirmationGapMs = DEFAULT_MIN_CONFIRMATION_GAP_MS,
  } = input;

  if (errored) return outcome('failed', 'scan_errored');
  if (!terminal || pageLimitReached) return outcome('partial', pageLimitReached ? 'page_limit_reached' : 'chain_unfinished');
  if (observedCount > 0) return outcome('complete', 'observed_listings');

  // Nothing observed. If we never had anything here either, there is no
  // inventory to protect and nothing to remove; that is a complete scan of an
  // empty scope, not a suspicious one.
  if (knownActiveCount === 0) return outcome('complete', 'empty_scope_no_inventory');

  const at = observedAt instanceof Date ? observedAt.getTime() : Date.parse(observedAt);
  const independent = [];
  let previous = Number.isFinite(at) ? at : Date.now();
  for (const run of priorEmptyRuns) {
    const runAt = run?.observedAt instanceof Date ? run.observedAt.getTime() : Date.parse(run?.observedAt);
    if (!Number.isFinite(runAt)) continue;
    if (previous - runAt < minConfirmationGapMs) continue;
    independent.push(runAt);
    previous = runAt;
  }

  const streak = independent.length + 1;
  return streak >= emptyConfirmations
    ? outcome('confirmed-empty', 'repeated_independent_empty_scans', { emptyStreak: streak })
    : outcome('suspect-empty', 'empty_but_inventory_known', { emptyStreak: streak, needed: emptyConfirmations });
}

function outcome(state, reason, extra = {}) {
  return Object.freeze({ state, reason, mayDeactivate: isRemovingScanState(state), ...extra });
}

/**
 * Guards a bulk deactivation. Returns what the caller should do rather than
 * doing it, so the decision is testable without a database.
 */
export function planInventoryReconciliation(outcomeValue, { staleCount = 0, maxRemovalRatio = 0.9, knownActiveCount = 0 } = {}) {
  if (!outcomeValue?.mayDeactivate) {
    return Object.freeze({ deactivate: false, reason: `scan_state_${outcomeValue?.state ?? 'unknown'}` });
  }
  // A "complete" scan that would nonetheless wipe almost everything is far
  // more likely to be a broken source than a genuinely emptied market.
  if (outcomeValue.state === 'complete' && knownActiveCount > 0 && staleCount / knownActiveCount > maxRemovalRatio) {
    return Object.freeze({ deactivate: false, reason: 'removal_ratio_exceeded', staleCount, knownActiveCount });
  }
  return Object.freeze({ deactivate: true, reason: outcomeValue.reason, staleCount });
}
