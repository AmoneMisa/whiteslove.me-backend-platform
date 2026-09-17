import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';

import {
  validateIntake, planStatusTransition, planIdentifierVerification, scopeSubjectData, canonicalIdentifier,
  requestDueAt, addMonths, newRequestReference, portabilityApplies, STATUS_TRANSITIONS, REQUEST_STATUSES,
} from '../src/privacy/privacy-requests.js';
import {
  validateDispute, correctionPlan, planDisputeResolution, markDisputedEvidence, DISPUTE_TYPES,
} from '../src/privacy/disputes.js';
import { resolveIntegrityScores, publicIntegrityStates, authorizeIntegrityAction } from '../src/identity/integrity-scores.js';
import {
  transitionPrivacyRequest, verifyRequestIdentifiers, restrictProcessing, findSubjectRecords, findPrivacyRequestStatus, resolveDisputeCase,
} from '../src/infrastructure/database/privacyRequestRepository.js';
import { installPrivacyRoutes } from '../src/routes/privacy-routes.js';

// --- intake --------------------------------------------------------------------

const intake = (extra = {}) => ({ requestType: 'access', requesterEmail: 'Person@Example.test', identifiers: [{ type: 'phone', value: '+998 90 123-45-67' }], ...extra });

test('intake canonicalises identifiers into the stored form', () => {
  const result = validateIntake(intake({ identifiers: [{ type: 'phone', value: '+998 90 123-45-67' }, { type: 'telegram', value: 'https://t.me/Owner_Flat' }, { type: 'phone', value: '+998901234567' }] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.request.claimedIdentifiers, [{ type: 'phone', value: '+998901234567' }, { type: 'telegram', value: 'owner_flat' }], 'duplicates collapse');
  assert.equal(result.request.requesterEmail, 'person@example.test');
});

test('intake drops fields it does not need', () => {
  const result = validateIntake(intake({ passportNumber: 'AA1234567', dateOfBirth: '1990-01-01' }));
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.request).sort(), ['claimedIdentifiers', 'details', 'requestType', 'requesterEmail']);
});

test('intake rejects what it cannot act on', () => {
  assert.deepEqual([...validateIntake(intake({ requestType: 'delete_everyone' })).errors], ['request_type_invalid']);
  assert.ok(validateIntake(intake({ requesterEmail: 'nope' })).errors.includes('requester_email_invalid'));
  assert.ok(validateIntake(intake({ identifiers: [] })).errors.includes('identifier_required'));
  assert.ok(validateIntake(intake({ identifiers: [{ type: 'phone', value: '12' }] })).errors.includes('identifier_value_invalid'));
  assert.ok(validateIntake(intake({ details: 'x'.repeat(5001) })).errors.includes('details_too_long'));
  assert.equal(validateIntake(null).ok, false);
});

test('identifiers that are not what they claim to be are refused', () => {
  assert.equal(canonicalIdentifier('email', 'a@b'), null);
  assert.equal(canonicalIdentifier('telegram', 'not a handle!'), null);
  assert.equal(canonicalIdentifier('facebook', '<script>'), null);
  assert.equal(canonicalIdentifier('unknown', 'x'), null);
});

test('deadlines follow Article 12(3) calendar months', () => {
  assert.equal(requestDueAt(new Date('2026-01-31T10:00:00Z')).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(requestDueAt(new Date('2026-03-15T00:00:00Z'), { extended: true }).toISOString(), '2026-06-15T00:00:00.000Z');
  assert.equal(addMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString(), '2028-02-29T00:00:00.000Z');
});

test('references are unguessable and do not expose ids', () => {
  const references = new Set(Array.from({ length: 200 }, newRequestReference));
  assert.equal(references.size, 200);
  for (const reference of references) assert.match(reference, /^PR-[A-Za-z0-9_-]{20}$/u);
});

// --- status workflow --------------------------------------------------------------

test('the workflow has exactly the six states and terminal states are final', () => {
  assert.deepEqual([...REQUEST_STATUSES], ['received', 'identity_verification_required', 'in_review', 'fulfilled', 'partially_fulfilled', 'rejected_with_reason']);
  for (const terminal of ['fulfilled', 'partially_fulfilled', 'rejected_with_reason']) assert.deepEqual([...STATUS_TRANSITIONS[terminal]], []);
});

test('rejection and partial fulfilment need a reason', () => {
  assert.equal(planStatusTransition({ to: 'rejected_with_reason', reviewer: 'r' }).error, 'reason_required');
  assert.equal(planStatusTransition({ to: 'partially_fulfilled', reviewer: 'r', reason: ' ' }).error, 'reason_required');
  assert.equal(planStatusTransition({ to: 'fulfilled', reviewer: 'r', from: 'received' }).error, 'transition_not_allowed', 'nothing is fulfilled without review');
  const plan = planStatusTransition({ to: 'fulfilled', reviewer: 'r' });
  assert.deepEqual([...plan.allowedFrom], ['in_review']);
  assert.equal(plan.closes, true);
});

test('only claimed identifiers can be verified', () => {
  const claimed = [{ type: 'phone', value: '+998901234567' }];
  assert.equal(planIdentifierVerification({ claimed, verified: [{ type: 'phone', value: '+998 90 123 45 67' }], method: 'code_to_phone', reviewer: 'r' }).ok, true);
  assert.equal(planIdentifierVerification({ claimed, verified: [{ type: 'phone', value: '+998911111111' }], method: 'code_to_phone', reviewer: 'r' }).error, 'identifier_not_claimed');
  assert.equal(planIdentifierVerification({ claimed, verified: claimed, method: 'passport_scan', reviewer: 'r' }).error, 'verification_method_invalid', 'no identity documents');
});

// --- scoping: never disclose another person's data ---------------------------------

const records = {
  contactPoints: [
    { id: 1, type: 'phone', canonicalValue: '+998901234567', origin: 'listing_text' },
    { id: 2, type: 'phone', canonicalValue: '+998907777777', origin: 'listing_text' },
  ],
  actors: [{ id: 10, contactPointIds: [1, 2], roles: ['owner'] }, { id: 11, contactPointIds: [2] }],
  platformIdentities: [{ actorId: 10, platform: 'telegram', username: 'mine' }, { actorId: 11, platform: 'telegram', username: 'someone_else' }],
  evidence: [{ actorId: 10, polarity: 'risk', reasonCode: 'identity_churn', detail: { otherListing: 'x' } }, { actorId: 11, polarity: 'risk', reasonCode: 'copied_inventory' }],
};

test('an unverified request discloses nothing', () => {
  const result = scopeSubjectData({ verifiedIdentifiers: [] }, records);
  assert.deepEqual(result, { ok: false, error: 'identity_verification_required' });
});

test('a verified phone does not disclose contacts or actors that are not the requester\'s', () => {
  const result = scopeSubjectData({ verifiedIdentifiers: [{ type: 'phone', value: '+998901234567' }] }, records);
  const serialized = JSON.stringify(result.data);
  assert.ok(!serialized.includes('+998907777777'), 'a contact merged onto the actor may be another person\'s');
  assert.ok(!serialized.includes('someone_else'), 'actors reached only through unverified contacts are excluded');
  assert.ok(!serialized.includes('otherListing'), 'evidence detail describes other people');
  assert.equal(result.withheld.contactPoints, 1);
  assert.equal(result.withheld.reason, 'linked_contacts_not_verified_as_requester', 'withholding is reported so the merge can be disputed');
  assert.equal(result.data.evidence[0].reasonCode, 'identity_churn', 'profiling reasons are disclosed (Art 15(1)(h))');
});

test('portability covers only data the person provided', () => {
  assert.equal(portabilityApplies('subscription_account'), true);
  assert.equal(portabilityApplies('public_listing_contact'), false);
});

// --- disputes ------------------------------------------------------------------

test('a dispute must point at what it disputes', () => {
  assert.equal(validateDispute({ disputeType: 'wrong_phone_association', actorId: 1 }).error, 'target_required');
  assert.equal(validateDispute({ disputeType: 'bogus' }).error, 'dispute_type_invalid');
  assert.equal(validateDispute({ disputeType: 'incorrect_risk_evidence', evidenceId: 5 }).ok, true);
  assert.equal(DISPUTE_TYPES.length, 6);
});

test('an upheld identity-merge dispute is a manual split, never an automatic one', () => {
  assert.deepEqual(correctionPlan({ disputeType: 'wrong_identity_merge', actorId: 3 }).map((step) => step.kind), ['split_actor_manually']);
  assert.deepEqual(correctionPlan({ disputeType: 'incorrect_risk_evidence', evidenceId: 9 })[0], { kind: 'review_action', action: 'reject', evidenceId: 9 });
});

test('every resolution, rejection included, needs a reviewer and a reason', () => {
  assert.equal(planDisputeResolution({ outcome: 'rejected', reviewer: 'r' }).error, 'note_required');
  assert.equal(planDisputeResolution({ outcome: 'erased', reviewer: 'r', note: 'n' }).error, 'outcome_invalid');
  assert.equal(planDisputeResolution({ outcome: 'upheld', reviewer: 'r', note: 'wrong number' }).ok, true);
});

const NOW = new Date('2026-09-01T00:00:00Z');
const evidenceRow = (extra) => ({ id: 1, actorId: 3, polarity: 'risk', dimension: 'availability_credibility', reasonCode: 'phantom_unavailable_inventory', independentCount: 5, reviewState: 'confirmed', reviewedBy: 'r', lastObservedAt: NOW.toISOString(), ...extra });

test('disputed evidence is neither erased nor used externally', () => {
  const evidence = markDisputedEvidence([evidenceRow()], [{ disputeType: 'incorrect_role', actorId: 3, status: 'open' }]);
  assert.equal(evidence.length, 1, 'nothing is removed on dispute');
  assert.equal(evidence[0].underDispute, true);
  const scores = resolveIntegrityScores(evidence, { now: NOW });
  assert.ok(scores.scores.availabilityCredibility < 0.5, 'still counted internally');
  assert.deepEqual([...publicIntegrityStates(scores, evidence, { now: NOW })], [], 'but not shown publicly');
  assert.equal(authorizeIntegrityAction('hide_all_listings', evidence).allowed, false, 'and not acted on');
  assert.equal(authorizeIntegrityAction('hide_all_listings', [evidenceRow()]).allowed, true, 'the same evidence undisputed is actionable');
});

test('a closed dispute no longer shields evidence; restriction does', () => {
  assert.equal(markDisputedEvidence([evidenceRow()], [{ disputeType: 'incorrect_role', actorId: 3, status: 'rejected' }])[0].underDispute, false);
  const restricted = [evidenceRow({ processingRestricted: true })];
  assert.deepEqual([...publicIntegrityStates(resolveIntegrityScores(restricted, { now: NOW }), restricted, { now: NOW })], []);
});

// --- repository ----------------------------------------------------------------

function fakeClient(responses) {
  const calls = [];
  const queue = [...responses];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); const rows = queue.length ? queue.shift() : []; return { rows, rowCount: rows.length }; } };
}

test('a request transition and its audit row are one guarded statement', async () => {
  const client = fakeClient([[{ id: '4', from_state: 'in_review', to_state: 'rejected_with_reason' }]]);
  const result = await transitionPrivacyRequest({ id: 4, to: 'rejected_with_reason', reason: 'not verifiable', reviewer: 'r' }, client);
  assert.deepEqual(result, { ok: true, id: 4, from: 'in_review', to: 'rejected_with_reason' });
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].sql, /FOR UPDATE[\s\S]*INSERT INTO platform\.review_audit_events/u);
  assert.equal((await transitionPrivacyRequest({ id: 4, to: 'fulfilled', reviewer: 'r' }, fakeClient([[]]))).error, 'conflict');
});

test('verification re-checks the claim list inside the update', async () => {
  const client = fakeClient([[{ claimed_identifiers: [{ type: 'phone', value: '+998901234567' }], status: 'received' }], [{ subject_id: '4' }]]);
  const result = await verifyRequestIdentifiers({ id: 4, identifiers: [{ type: 'phone', value: '+998901234567' }], method: 'code_to_phone', reviewer: 'r' }, client);
  assert.equal(result.ok, true);
  assert.match(client.calls[1].sql, /claimed_identifiers @> \$2::jsonb/u);
});

test('subject lookup is a fixed number of queries and stops early when nothing matches', async () => {
  const empty = fakeClient([[]]);
  assert.deepEqual(await findSubjectRecords([{ type: 'phone', value: '+998901234567' }], empty), { contactPoints: [], actors: [], platformIdentities: [], evidence: [] });
  assert.equal(empty.calls.length, 1);
  assert.match(empty.calls[0].sql, /unnest\(\$1::varchar\[\], \$2::text\[\]\)/u);

  const client = fakeClient([
    [{ id: '1', type: 'phone', canonical_value: '+998901234567' }],
    [{ id: '10', contact_point_ids: ['1', '2'], roles: ['owner'] }],
    [{ id: '2', type: 'phone', canonical_value: '+998907777777' }],
    [{ actor_id: '10', platform: 'telegram', username: 'mine' }],
    [],
  ]);
  const found = await findSubjectRecords(Array.from({ length: 10 }, () => ({ type: 'phone', value: '+998901234567' })), client);
  assert.equal(client.calls.length, 5, 'independent of identifier count');
  assert.deepEqual(client.calls[2].params[0], [2], 'only the other linked contacts are fetched');
  assert.equal(found.contactPoints.length, 2);
});

test('restriction and objection are audited per subject in one statement', async () => {
  const client = fakeClient([[{ subject_type: 'actor', affected: 2 }]]);
  const result = await restrictProcessing({ actorIds: [1, 1, 2], contactPointIds: [5], kind: 'objection', reviewer: 'r' }, client);
  assert.deepEqual(result, { ok: true, actors: 2, contactPoints: 0 });
  assert.deepEqual(client.calls[0].params[1], [], 'an objection is keyed on the person, not the contact');
  assert.match(client.calls[0].sql, /processing_objection_at = COALESCE\(processing_objection_at, NOW\(\)\)/u, 'the first objection time is kept');
  assert.equal((await restrictProcessing({ kind: 'erase', actorIds: [1], reviewer: 'r' }, client)).error, 'kind_invalid');
});

test('status lookup rejects malformed references without a query', async () => {
  const client = fakeClient([]);
  assert.equal(await findPrivacyRequestStatus("1' OR '1'='1", client), null);
  assert.equal(client.calls.length, 0);
});

test('dispute resolution is guarded and audited', async () => {
  const client = fakeClient([[{ id: '7', from_state: 'open', to_state: 'upheld' }]]);
  assert.equal((await resolveDisputeCase({ id: 7, outcome: 'upheld', note: 'number belongs to someone else', reviewer: 'r' }, client)).ok, true);
  assert.match(client.calls[0].sql, /'dispute_case', id, 'resolve'/u);
});

// --- HTTP ----------------------------------------------------------------------

const ADMIN_KEY = 'k'.repeat(40);

async function withServer(deps, run) {
  const app = express();
  app.use(express.json());
  installPrivacyRoutes(app, { checkRate: () => true, log: () => {}, env: { PRIVACY_ADMIN_KEY: ADMIN_KEY }, ...deps });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('intake answers the same whether or not data exists, and is not cached', async () => {
  const privacyRepository = { createPrivacyRequest: async () => ({ reference: 'PR-abc', status: 'received', dueAt: '2026-10-01' }) };
  await withServer({ privacyRepository }, async (base) => {
    const response = await fetch(`${base}/api/privacy/requests`, json(intake()));
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['dueAt', 'ok', 'reference', 'status']);
    assert.equal((await fetch(`${base}/api/privacy/requests`, json({ requestType: 'access' }))).status, 400);
  });
});

test('intake is rate limited', async () => {
  await withServer({ checkRate: (_req, res) => { res.status(429).json({ error: 'Too many requests' }); return false; } }, async (base) => {
    assert.equal((await fetch(`${base}/api/privacy/requests`, json(intake()))).status, 429);
  });
});

test('admin endpoints require the dedicated admin key and a reviewer', async () => {
  const privacyRepository = { listOpenPrivacyRequests: async () => ({ items: [], next: null }) };
  await withServer({ privacyRepository }, async (base) => {
    const url = `${base}/api/admin/privacy/requests`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-admin-key': 'wrong' } })).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-queue-key': ADMIN_KEY } })).status, 401, 'the shared queue header is not accepted');
    assert.equal((await fetch(url, { headers: { 'x-admin-key': ADMIN_KEY } })).status, 400, 'every admin action names its reviewer');
    assert.equal((await fetch(url, { headers: { 'x-admin-key': ADMIN_KEY, 'x-reviewer': 'operator' } })).status, 200);
  });
});

test('admin endpoints are closed when no admin key is configured', async () => {
  await withServer({ env: {} }, async (base) => {
    assert.equal((await fetch(`${base}/api/admin/review/queue`, { headers: { 'x-admin-key': '', 'x-reviewer': 'r' } })).status, 503);
  });
  await withServer({ env: { PRIVACY_ADMIN_KEY: 'short', QUEUE_INTERNAL_KEY: ADMIN_KEY } }, async (base) => {
    assert.equal((await fetch(`${base}/api/admin/review/queue`, { headers: { 'x-admin-key': 'short', 'x-reviewer': 'r' } })).status, 503, 'a weak key is treated as unset');
  });
});

test('subject data is refused until identifiers are verified', async () => {
  let looked = false;
  const privacyRepository = {
    getPrivacyRequest: async () => ({ id: 1, verifiedIdentifiers: [] }),
    findSubjectRecords: async () => { looked = true; return {}; },
  };
  await withServer({ privacyRepository }, async (base) => {
    const response = await fetch(`${base}/api/admin/privacy/requests/1/subject-data`, { headers: { 'x-admin-key': ADMIN_KEY, 'x-reviewer': 'r' } });
    assert.equal(response.status, 409);
    assert.equal(looked, false, 'no lookup happens before verification');
  });
});

test('errors are logged without personal data', async () => {
  const lines = [];
  const privacyRepository = { createPrivacyRequest: async () => { const error = new Error('duplicate key value (requester_email)=(person@example.test)'); error.code = '23505'; throw error; } };
  await withServer({ privacyRepository, log: (line) => lines.push(line) }, async (base) => {
    const response = await fetch(`${base}/api/privacy/requests`, json(intake()));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal_error' });
  });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('person@example.test'));
  assert.ok(!lines[0].includes('998'));
});

test('review conflicts surface as 409', async () => {
  const reviewRepository = { applyReviewAction: async () => ({ ok: false, error: 'conflict' }) };
  await withServer({ reviewRepository }, async (base) => {
    const response = await fetch(`${base}/api/admin/review/evidence/5/action`, { ...json({ action: 'watch' }), headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY, 'x-reviewer': 'r' } });
    assert.equal(response.status, 409);
  });
});

test('migration 055 encodes the workflow invariants', async () => {
  const sql = await readFile(new URL('../migrations/055_privacy_requests.sql', import.meta.url), 'utf8');
  assert.match(sql, /'received', 'identity_verification_required', 'in_review', 'fulfilled', 'partially_fulfilled', 'rejected_with_reason'/u);
  assert.match(sql, /status NOT IN \('partially_fulfilled', 'rejected_with_reason'\) OR resolution_reason IS NOT NULL/u);
  assert.match(sql, /DEFAULT 'pending_legal_review'/u, 'no assumed Article 14 exemption');
  assert.match(sql, /status <> 'exemption_documented' OR exemption_reasoning IS NOT NULL/u);
  assert.match(sql, /evidence_id BIGINT REFERENCES platform\.actor_evidence\(id\) ON DELETE SET NULL/u);
  assert.match(sql, /'privacy_request', 'dispute_case', 'article14_notice'/u);
});

test('the app composes the privacy routes', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(source, /installPrivacyRoutes\(app\)/u);
});
