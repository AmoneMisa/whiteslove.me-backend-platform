import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  detectPaymentSignals, assessPaymentDestinations, assessApplicationFeePattern, PAYMENT_RISK_REASONS,
} from '../src/identity/payment-signals.js';
import {
  resolveIntegrityScores, publicIntegrityStates, authorizeIntegrityAction, planReviewAction,
  independenceStrength, DIMENSIONS, HIGH_IMPACT_ACTIONS, REVIEW_TRANSITIONS,
} from '../src/identity/integrity-scores.js';
import {
  listReviewQueue, applyReviewAction, loadActorEvidence, listReviewHistory,
} from '../src/infrastructure/database/integrityReviewRepository.js';

const codes = (result) => result.findings.map((finding) => finding.reasonCode);
const NOW = new Date('2026-09-01T00:00:00.000Z');

// --- payment signals (§27) ---------------------------------------------------

test('an ordinary deposit is not a payment signal', () => {
  for (const text of [
    'Deposit one month, payment monthly. Viewing any day.',
    'Залог за один месяц, оплата помесячно, коммунальные отдельно.',
    "Zakalat bir oylik, to'lov har oy.",
  ]) {
    assert.deepEqual(codes(detectPaymentSignals(text)), [], text);
  }
});

test('payment before viewing is detected in each language', () => {
  for (const text of [
    'Please transfer the deposit before the viewing, many people want it.',
    'Нужна предоплата до просмотра, иначе квартиру не держу.',
    "Ko'rishdan oldin oldindan to'lov qiling.",
  ]) {
    assert.ok(codes(detectPaymentSignals(text)).includes('payment_before_verification'), text);
  }
});

test('payment and viewing far apart in a long listing do not pair', () => {
  const text = `Deposit one month. ${'Bright flat near the park with a renovated kitchen. '.repeat(6)} Without a viewing we do not sign anything.`;
  assert.ok(!codes(detectPaymentSignals(text)).includes('payment_before_verification'));
});

test('urgency next to payment is pressure; urgency alone is not', () => {
  assert.ok(codes(detectPaymentSignals('Срочно переведите аванс, много желающих')).includes('payment_pressure'));
  assert.deepEqual(codes(detectPaymentSignals('Срочно сдаётся квартира у метро')), []);
});

test('a card number or SMS code request is always sensitive', () => {
  assert.ok(codes(detectPaymentSignals('Send me your card number and the SMS code to confirm')).includes('premature_identity_data_request'));
  assert.ok(codes(detectPaymentSignals('Пришлите номер карты')).includes('premature_identity_data_request'));
});

test('a passport at contract signing is ordinary; asked for up front it is not', () => {
  assert.deepEqual(codes(detectPaymentSignals('Договор оформляем по паспорту при заселении.')), []);
  assert.ok(codes(detectPaymentSignals('Сначала пришлите фото паспорта, потом покажу квартиру')).includes('premature_identity_data_request'));
});

test('findings carry an offset, never the matched text', () => {
  const text = 'Send me your card number 4111 1111 1111 1111 please';
  const finding = detectPaymentSignals(text).findings[0];
  assert.equal(typeof finding.detail.offset, 'number');
  assert.ok(!JSON.stringify(finding).includes('4111'), 'evidence must not store card numbers');
});

test('a credit check sent to an external link is flagged', () => {
  assert.ok(codes(detectPaymentSignals('Complete a credit check here first: https://example.test/check')).includes('third_party_credit_check_risk'));
  assert.deepEqual(codes(detectPaymentSignals('The owner may ask about your credit history.')), []);
});

test('a viewing fee is recorded per listing, not yet as a pattern', () => {
  const result = detectPaymentSignals('Платный просмотр, 50 000 сум');
  assert.ok(codes(result).includes('viewing_fee_requested'));
  assert.ok(!codes(result).includes('application_fee_harvesting_pattern'));
});

test('viewing fees become a pattern only across independent properties', () => {
  const listing = (property) => ({ propertyClusterId: property, viewingFeeRequested: true });
  assert.deepEqual(assessApplicationFeePattern([listing('a'), listing('a'), listing('a'), listing('b')]).findings, [], 'one property many times is one observation');
  const result = assessApplicationFeePattern([listing('a'), listing('b'), listing('c')]);
  assert.equal(result.findings[0].reasonCode, 'application_fee_harvesting_pattern');
  assert.equal(result.findings[0].independentCount, 3);
});

test('a changed payment recipient on one property is reported', () => {
  assert.deepEqual(assessPaymentDestinations([{ propertyClusterId: 'p', recipientKey: 'h1' }, { propertyClusterId: 'p', recipientKey: 'h1' }]).findings, []);
  const result = assessPaymentDestinations([{ propertyClusterId: 'p', recipientKey: 'h1' }, { propertyClusterId: 'p', recipientKey: 'h2' }]);
  assert.equal(result.findings[0].reasonCode, 'payment_destination_changed');
});

test('every payment reason code is declared', () => {
  assert.equal(PAYMENT_RISK_REASONS.length, 6);
  assert.deepEqual(codes(detectPaymentSignals('')), []);
});

// --- scores (§34) ------------------------------------------------------------

const row = (extra) => ({ polarity: 'risk', dimension: 'payment_risk', reasonCode: 'payment_before_verification', independentCount: 1, reviewState: 'open', lastObservedAt: NOW.toISOString(), ...extra });

test('there is no single fraud score, only named dimensions', () => {
  const result = resolveIntegrityScores([row()], { now: NOW });
  assert.deepEqual(Object.keys(result.scores).sort(), ['actorBehaviorRisk', 'availabilityCredibility', 'identityRisk', 'paymentRisk', 'propertyReality', 'provenanceRisk']);
  assert.equal(DIMENSIONS.length, 6);
  assert.equal(result.internalOnly, true);
});

test('no evidence is unknown, not clean', () => {
  const result = resolveIntegrityScores([], { now: NOW });
  for (const value of Object.values(result.scores)) assert.equal(value, null);
});

test('every score comes with the reasons that produced it', () => {
  const result = resolveIntegrityScores([row({ id: 7 })], { now: NOW });
  const reason = result.breakdown.paymentRisk.reasons[0];
  assert.equal(reason.id, 7);
  assert.equal(reason.reasonCode, 'payment_before_verification');
  assert.ok(reason.contribution > 0);
  assert.ok(result.scores.paymentRisk > 0 && result.scores.paymentRisk < 1);
});

test('independent evidence strengthens a reason, with diminishing returns', () => {
  assert.equal(independenceStrength(1), 0.5);
  assert.equal(independenceStrength(3), 0.875);
  const one = resolveIntegrityScores([row({ independentCount: 1 })], { now: NOW }).scores.paymentRisk;
  const three = resolveIntegrityScores([row({ independentCount: 3 })], { now: NOW }).scores.paymentRisk;
  assert.ok(three > one);
});

test('many weak reasons do not add up to one strong one', () => {
  const weak = Array.from({ length: 6 }, () => row({ dimension: 'identity_risk', reasonCode: 'legacy_registry_risk' }));
  const manyWeak = resolveIntegrityScores(weak, { now: NOW }).scores.identityRisk;
  const oneStrong = resolveIntegrityScores([row()], { now: NOW }).scores.paymentRisk;
  assert.ok(manyWeak < oneStrong, `${manyWeak} should be below ${oneStrong}`);
});

test('a legacy spreadsheet label weighs less than observed behaviour', () => {
  const legacy = resolveIntegrityScores([row({ dimension: 'identity_risk', reasonCode: 'legacy_registry_risk' })], { now: NOW }).scores.identityRisk;
  const observed = resolveIntegrityScores([row({ dimension: 'identity_risk', reasonCode: 'undeclared_broker_pattern' })], { now: NOW }).scores.identityRisk;
  assert.ok(legacy < observed);
});

test('dismissed evidence counts for nothing but stays visible', () => {
  const result = resolveIntegrityScores([row({ reviewState: 'dismissed' })], { now: NOW });
  assert.equal(result.scores.paymentRisk, null);
  assert.equal(result.breakdown.paymentRisk.reasons[0].reviewState, 'dismissed');
});

test('trust softens risk but cannot erase a confirmed finding', () => {
  const trust = { polarity: 'trust', dimension: 'identity_risk', reasonCode: 'stable_identity', independentCount: 10, reviewState: 'open', lastObservedAt: NOW.toISOString() };
  const risk = row({ dimension: 'identity_risk', reasonCode: 'owner_identity_inconsistent', independentCount: 3 });
  const alone = resolveIntegrityScores([risk], { now: NOW }).scores.identityRisk;
  const softened = resolveIntegrityScores([risk, trust], { now: NOW }).scores.identityRisk;
  assert.ok(softened < alone);
  const confirmed = resolveIntegrityScores([{ ...risk, reviewState: 'confirmed' }, trust], { now: NOW }).scores.identityRisk;
  assert.ok(confirmed > 0);
});

test('stale evidence counts less', () => {
  const fresh = resolveIntegrityScores([row()], { now: NOW }).scores.paymentRisk;
  const stale = resolveIntegrityScores([row({ lastObservedAt: '2025-01-01T00:00:00.000Z' })], { now: NOW }).scores.paymentRisk;
  assert.ok(stale < fresh);
});

test('positive dimensions read the right way round', () => {
  const doubtful = resolveIntegrityScores([row({ dimension: 'availability_credibility', reasonCode: 'phantom_unavailable_inventory', independentCount: 4 })], { now: NOW });
  assert.ok(doubtful.scores.availabilityCredibility < 0.5, 'more risk means less credibility');
});

// --- public states (§35) -----------------------------------------------------

test('public states describe listings and never accuse a person', () => {
  const evidence = [
    row({ independentCount: 5, reviewState: 'confirmed' }),
    row({ dimension: 'identity_risk', reasonCode: 'undeclared_broker_pattern', independentCount: 8 }),
    row({ dimension: 'availability_credibility', reasonCode: 'phantom_unavailable_inventory', independentCount: 4 }),
    row({ dimension: 'provenance_risk', reasonCode: 'repeated_fresh_relisting', independentCount: 4 }),
  ];
  const states = publicIntegrityStates(resolveIntegrityScores(evidence, { now: NOW }), evidence);
  assert.ok(states.includes('listing_availability_uncertain'));
  assert.ok(states.includes('listing_appears_repeatedly'));
  assert.ok(states.includes('source_information_inconsistent'));
  assert.ok(!states.some((state) => /fraud|scam|payment|identity|blacklist/u.test(state)));
});

test('dismissed repetition evidence produces no public state', () => {
  const evidence = [row({ dimension: 'provenance_risk', reasonCode: 'repeated_fresh_relisting', reviewState: 'dismissed' })];
  assert.deepEqual(publicIntegrityStates(resolveIntegrityScores(evidence, { now: NOW }), evidence), []);
});

// --- human review gate (§36) -------------------------------------------------

test('no score is high enough to take a high-impact action on its own', () => {
  const overwhelming = Array.from({ length: 20 }, (_, i) => row({ id: i, independentCount: 50 }));
  for (const action of HIGH_IMPACT_ACTIONS) {
    const decision = authorizeIntegrityAction(action, overwhelming);
    assert.equal(decision.allowed, false, action);
    assert.equal(decision.reason, 'no_confirmed_evidence');
  }
});

test('a high-impact action needs evidence a named reviewer confirmed', () => {
  assert.equal(authorizeIntegrityAction('public_blacklist', [row({ reviewState: 'confirmed' })]).allowed, false, 'confirmed without a reviewer name is not a human decision');
  const decision = authorizeIntegrityAction('public_blacklist', [row({ id: 9, reviewState: 'confirmed', reviewedBy: 'reviewer@example.test' })]);
  assert.equal(decision.allowed, true);
  assert.deepEqual([...decision.confirmedEvidenceIds], [9]);
});

test('routing to review is automatic; unknown actions are refused', () => {
  assert.equal(authorizeIntegrityAction('queue_for_review').allowed, true);
  assert.equal(authorizeIntegrityAction('delete_everything').allowed, false);
});

test('review actions validate reviewer and note', () => {
  assert.equal(planReviewAction({ action: 'approve', reviewer: 'r' }).error, 'note_required');
  assert.equal(planReviewAction({ action: 'watch', reviewer: ' ' }).error, 'reviewer_required');
  assert.equal(planReviewAction({ action: 'ban', reviewer: 'r' }).error, 'unknown_action');
  assert.equal(planReviewAction({ action: 'reject', reviewer: 'r', note: 'x'.repeat(2001) }).error, 'note_too_long');
  const plan = planReviewAction({ action: 'watch', reviewer: ' r ' });
  assert.equal(plan.ok, true);
  assert.equal(plan.to, 'watch');
  assert.equal(plan.reviewer, 'r');
  assert.deepEqual(Object.keys(REVIEW_TRANSITIONS).sort(), ['approve', 'reject', 'reopen', 'resolve', 'watch']);
});

// --- repository --------------------------------------------------------------

function fakeClient(rows = []) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } };
}

const evidenceRow = (id, extra = {}) => ({ id: String(id), actor_id: '3', polarity: 'risk', reason_code: 'x', dimension: 'payment_risk', independent_count: 2, detail: {}, review_state: 'open', reviewed_by: null, reviewed_at: null, first_observed_at: NOW, last_observed_at: NOW, ...extra });

test('the queue fetches one extra row instead of counting', async () => {
  const client = fakeClient([evidenceRow(3), evidenceRow(2), evidenceRow(1)]);
  const page = await listReviewQueue({ limit: 2 }, client);
  assert.equal(client.calls[0].params[0], 3);
  assert.ok(!/count\(/iu.test(client.calls[0].sql));
  assert.ok(!/offset/iu.test(client.calls[0].sql), 'OFFSET reads and discards every earlier row');
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.next, { independentCount: 2, lastObservedAt: NOW, id: 2 });
});

test('the queue cursor matches the index order', async () => {
  const client = fakeClient([]);
  const page = await listReviewQueue({ limit: 500, after: { independentCount: 2, lastObservedAt: NOW, id: 2 } }, client);
  assert.match(client.calls[0].sql, /\(independent_count, last_observed_at, id\) < /u);
  assert.match(client.calls[0].sql, /ORDER BY independent_count DESC, last_observed_at DESC, id DESC/u);
  assert.equal(client.calls[0].params[0], 101, 'page size is capped');
  assert.equal(page.next, null);
});

test('a review decision and its audit record are one statement', async () => {
  const client = fakeClient([{ id: '5', from_state: 'open', to_state: 'confirmed' }]);
  const result = await applyReviewAction({ evidenceId: 5, action: 'approve', reviewer: 'r', note: 'checked the listing' }, client);
  assert.deepEqual(result, { ok: true, evidenceId: 5, from: 'open', to: 'confirmed' });
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].sql, /FOR UPDATE/u);
  assert.match(client.calls[0].sql, /INSERT INTO platform\.review_audit_events/u);
  assert.deepEqual(client.calls[0].params[3], ['open', 'watch']);
});

test('a decision on a row that already moved is a conflict', async () => {
  const result = await applyReviewAction({ evidenceId: 5, action: 'watch', reviewer: 'r' }, fakeClient([]));
  assert.deepEqual(result, { ok: false, error: 'conflict' });
});

test('invalid review requests never reach the database', async () => {
  const client = fakeClient([]);
  assert.equal((await applyReviewAction({ evidenceId: 'x', action: 'watch', reviewer: 'r' }, client)).error, 'invalid_evidence_id');
  assert.equal((await applyReviewAction({ evidenceId: 1, action: 'approve', reviewer: 'r' }, client)).error, 'note_required');
  assert.equal(client.calls.length, 0);
});

test('actor evidence and review history load in one query each', async () => {
  const client = fakeClient([evidenceRow(1), evidenceRow(2, { actor_id: '4' })]);
  const byActor = await loadActorEvidence([3, 3, 4, 'x'], client);
  assert.deepEqual(client.calls[0].params[0], [3, 4]);
  assert.equal(byActor.get(3).length, 1);
  assert.equal((await loadActorEvidence([], client)).size, 0);
  assert.equal(client.calls.length, 1);

  const history = fakeClient([{ id: '1', subject_type: 'actor_evidence', subject_id: '5', action: 'approve', from_state: 'open', to_state: 'confirmed', reviewer: 'r', note: 'n', created_at: NOW }]);
  const events = await listReviewHistory({ subjectId: 5 }, history);
  assert.equal(events[0].to, 'confirmed');
  assert.match(history.calls[0].sql, /ORDER BY id DESC/u);
});

test('migration 054 adds the resolved state, keyset index and audit table', async () => {
  const sql = await readFile(new URL('../migrations/054_integrity_review.sql', import.meta.url), 'utf8');
  assert.match(sql, /'resolved'/u);
  assert.match(sql, /actor_evidence_queue_keyset_idx[\s\S]*id DESC\)[\s\S]*WHERE review_state IN \('open', 'watch'\)/u);
  assert.match(sql, /review_audit_events[\s\S]*fillfactor = 100/u);
  assert.match(sql, /USING brin \(created_at\)/u);
});
