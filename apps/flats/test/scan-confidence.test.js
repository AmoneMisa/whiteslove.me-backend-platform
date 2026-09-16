import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCAN_STATES,
  DEFAULT_EMPTY_CONFIRMATIONS,
  DEFAULT_MIN_CONFIRMATION_GAP_MS,
  classifyScanOutcome,
  planInventoryReconciliation,
  isRemovingScanState,
} from '../src/sources/scan-confidence.js';

const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(Date.UTC(2026, 0, 10, 12) - hoursAgo * HOUR);
const NOW = at(0);

const classify = (input) => classifyScanOutcome({ terminal: true, observedAt: NOW, ...input });

test('the lifecycle states are exactly those the policy defines', () => {
  assert.deepEqual([...SCAN_STATES], ['complete', 'partial', 'failed', 'suspect-empty', 'confirmed-empty']);
});

test('only complete and confirmed-empty scans may remove inventory', () => {
  assert.equal(isRemovingScanState('complete'), true);
  assert.equal(isRemovingScanState('confirmed-empty'), true);
  for (const state of ['partial', 'failed', 'suspect-empty', 'unknown']) {
    assert.equal(isRemovingScanState(state), false, state);
  }
});

test('a scan that saw listings and finished is complete', () => {
  const outcome = classify({ observedCount: 120, knownActiveCount: 500 });
  assert.equal(outcome.state, 'complete');
  assert.equal(outcome.mayDeactivate, true);
});

test('an errored scan is failed and concludes nothing', () => {
  const outcome = classify({ observedCount: 0, knownActiveCount: 500, errored: true });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.mayDeactivate, false);
});

test('an error outranks everything else, including a full page of results', () => {
  assert.equal(classify({ observedCount: 900, knownActiveCount: 500, errored: true }).state, 'failed');
});

test('an unfinished chain is partial', () => {
  assert.equal(classify({ observedCount: 50, knownActiveCount: 500, terminal: false }).state, 'partial');
});

test('hitting the page cap is partial, not complete', () => {
  const outcome = classify({ observedCount: 5000, knownActiveCount: 5000, pageLimitReached: true });
  assert.equal(outcome.state, 'partial');
  assert.equal(outcome.reason, 'page_limit_reached');
  assert.equal(outcome.mayDeactivate, false, 'a truncated crawl must never deactivate the tail it never reached');
});

test('a single empty scan over known inventory is suspect, not authoritative', () => {
  // The failure this prevents: a source under maintenance returns well-formed
  // empty pages, the chain terminates on page one, and the whole country's
  // inventory is deactivated on that evidence alone.
  const outcome = classify({ observedCount: 0, knownActiveCount: 4000 });
  assert.equal(outcome.state, 'suspect-empty');
  assert.equal(outcome.mayDeactivate, false);
  assert.equal(outcome.emptyStreak, 1);
  assert.equal(outcome.needed, DEFAULT_EMPTY_CONFIRMATIONS);
});

test('an empty scan of a scope with no inventory is simply complete', () => {
  const outcome = classify({ observedCount: 0, knownActiveCount: 0 });
  assert.equal(outcome.state, 'complete');
  assert.equal(outcome.reason, 'empty_scope_no_inventory');
});

test('repeated independent empty scans confirm emptiness', () => {
  const outcome = classify({
    observedCount: 0,
    knownActiveCount: 4000,
    priorEmptyRuns: [{ observedAt: at(12) }, { observedAt: at(30) }],
  });
  assert.equal(outcome.state, 'confirmed-empty');
  assert.equal(outcome.emptyStreak, DEFAULT_EMPTY_CONFIRMATIONS);
  assert.equal(outcome.mayDeactivate, true);
});

test('two empty scans are not yet enough', () => {
  const outcome = classify({ observedCount: 0, knownActiveCount: 4000, priorEmptyRuns: [{ observedAt: at(12) }] });
  assert.equal(outcome.state, 'suspect-empty');
  assert.equal(outcome.emptyStreak, 2);
});

test('empty scans crowded into one outage are not independent evidence', () => {
  // Three scans an hour apart are one outage observed three times. Treating
  // them as confirmation would let a single incident wipe the inventory.
  const outcome = classify({
    observedCount: 0,
    knownActiveCount: 4000,
    priorEmptyRuns: [{ observedAt: at(1) }, { observedAt: at(2) }, { observedAt: at(3) }],
  });
  assert.equal(outcome.state, 'suspect-empty');
  assert.equal(outcome.emptyStreak, 1, 'none of the crowded runs counted');
  assert.ok(DEFAULT_MIN_CONFIRMATION_GAP_MS > HOUR);
});

test('the confirmation gap is measured between consecutive runs, not from now', () => {
  const outcome = classify({
    observedCount: 0,
    knownActiveCount: 4000,
    priorEmptyRuns: [{ observedAt: at(8) }, { observedAt: at(9) }, { observedAt: at(20) }],
  });
  assert.equal(outcome.emptyStreak, 3, 'the 9h run is too close to the 8h one and is skipped, the 20h one counts');
  assert.equal(outcome.state, 'confirmed-empty');
});

test('the confirmation threshold is configurable', () => {
  const outcome = classify({ observedCount: 0, knownActiveCount: 4000, emptyConfirmations: 1 });
  assert.equal(outcome.state, 'confirmed-empty');
});

test('malformed prior timestamps are ignored rather than counted', () => {
  const outcome = classify({
    observedCount: 0,
    knownActiveCount: 4000,
    priorEmptyRuns: [{ observedAt: 'not a date' }, { observedAt: null }],
  });
  assert.equal(outcome.emptyStreak, 1);
  assert.equal(outcome.state, 'suspect-empty');
});

test('a non-removing scan plans no deactivation', () => {
  for (const state of ['partial', 'failed', 'suspect-empty']) {
    const plan = planInventoryReconciliation({ state, mayDeactivate: false }, { staleCount: 900, knownActiveCount: 1000 });
    assert.equal(plan.deactivate, false, state);
    assert.equal(plan.reason, `scan_state_${state}`);
  }
});

test('a complete scan deactivates the listings it did not see', () => {
  const plan = planInventoryReconciliation(classify({ observedCount: 800, knownActiveCount: 1000 }), { staleCount: 200, knownActiveCount: 1000 });
  assert.equal(plan.deactivate, true);
  assert.equal(plan.staleCount, 200);
});

test('a complete scan that would wipe almost everything is refused', () => {
  // More likely a broken source than a genuinely emptied market.
  const plan = planInventoryReconciliation(classify({ observedCount: 5, knownActiveCount: 1000 }), { staleCount: 995, knownActiveCount: 1000 });
  assert.equal(plan.deactivate, false);
  assert.equal(plan.reason, 'removal_ratio_exceeded');
});

test('a confirmed-empty scan may clear the scope despite the ratio', () => {
  const outcome = classify({
    observedCount: 0,
    knownActiveCount: 1000,
    priorEmptyRuns: [{ observedAt: at(12) }, { observedAt: at(30) }],
  });
  const plan = planInventoryReconciliation(outcome, { staleCount: 1000, knownActiveCount: 1000 });
  assert.equal(plan.deactivate, true, 'emptiness has been earned by repeated independent evidence');
});

test('an unknown outcome is treated as non-removing', () => {
  assert.equal(planInventoryReconciliation(undefined, { staleCount: 10 }).deactivate, false);
  assert.equal(planInventoryReconciliation(null, {}).reason, 'scan_state_unknown');
});
