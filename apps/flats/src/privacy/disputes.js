/**
 * Correction and dispute workflow (§49, GDPR Articles 16 and 18(1)(a)).
 *
 * Two failure modes are ruled out by construction:
 *
 *  - Erasing evidence because someone disputed it. A dispute is a claim; the
 *    person running a phantom-listing operation disputes too. Nothing here
 *    deletes or dismisses anything on intake.
 *
 *  - Ignoring the dispute. While a dispute is open, the disputed evidence is
 *    kept out of public states and high-impact actions (Article 18(1)(a): the
 *    accuracy is contested), and the case stays on the worklist until a named
 *    person decides it with a written reason.
 *
 * An upheld dispute produces a correction plan -- the concrete changes a
 * reviewer applies -- rather than applying them itself, because several of
 * them (splitting an actor) need judgement about which observations belong to
 * whom.
 */

export const DISPUTE_TYPES = Object.freeze([
  'wrong_phone_association',
  'wrong_identity_merge',
  'incorrect_role',
  'stale_username',
  'wrong_property_association',
  'incorrect_risk_evidence',
]);

export const DISPUTE_STATUSES = Object.freeze(['open', 'in_review', 'upheld', 'partially_upheld', 'rejected']);
export const OPEN_DISPUTE_STATUSES = Object.freeze(['open', 'in_review']);
const OUTCOMES = new Set(['upheld', 'partially_upheld', 'rejected']);

/** What each dispute type must point at, so a case is actionable. */
const REQUIRED_TARGET = Object.freeze({
  wrong_phone_association: ['actorId', 'contactPointId'],
  wrong_identity_merge: ['actorId'],
  incorrect_role: ['actorId'],
  stale_username: ['actorId'],
  wrong_property_association: ['actorId', 'propertyClusterId'],
  incorrect_risk_evidence: ['evidenceId'],
});

const positiveId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

/** Validates a new dispute case. */
export function validateDispute(input = {}) {
  const disputeType = String(input.disputeType ?? '');
  if (!DISPUTE_TYPES.includes(disputeType)) return Object.freeze({ ok: false, error: 'dispute_type_invalid' });
  const target = {
    actorId: positiveId(input.actorId),
    contactPointId: positiveId(input.contactPointId),
    evidenceId: positiveId(input.evidenceId),
    propertyClusterId: positiveId(input.propertyClusterId),
  };
  const missing = REQUIRED_TARGET[disputeType].filter((field) => target[field] === null);
  if (missing.length) return Object.freeze({ ok: false, error: 'target_required', missing: Object.freeze(missing) });
  const statement = typeof input.statement === 'string' ? input.statement.trim() : '';
  if (statement.length > 5000) return Object.freeze({ ok: false, error: 'statement_too_long' });
  return Object.freeze({
    ok: true,
    dispute: Object.freeze({ disputeType, ...target, statement: statement || null, privacyRequestId: positiveId(input.privacyRequestId) }),
  });
}

/**
 * The corrections an upheld dispute calls for. Returned for a reviewer to
 * apply, each through its own audited action.
 */
export function correctionPlan(dispute) {
  const { disputeType, actorId, contactPointId, evidenceId, propertyClusterId } = dispute ?? {};
  switch (disputeType) {
    case 'wrong_phone_association':
      return Object.freeze([
        { kind: 'unlink_contact_point', actorId, contactPointId },
        { kind: 'review_evidence_derived_from_contact', actorId, contactPointId },
      ]);
    case 'wrong_identity_merge':
      // Which observations belong to which person is a judgement, so this is
      // a manual split, never an automatic one.
      return Object.freeze([{ kind: 'split_actor_manually', actorId }]);
    case 'incorrect_role':
      return Object.freeze([{ kind: 'correct_actor_role', actorId }]);
    case 'stale_username':
      return Object.freeze([{ kind: 'mark_platform_identity_historical', actorId }]);
    case 'wrong_property_association':
      return Object.freeze([{ kind: 'unlink_property_cluster', actorId, propertyClusterId }]);
    case 'incorrect_risk_evidence':
      // Through the ordinary review action, so the dismissal lands in the same
      // audit trail as every other evidence decision.
      return Object.freeze([{ kind: 'review_action', action: 'reject', evidenceId }]);
    default:
      return Object.freeze([]);
  }
}

/** Validates a resolution. Every outcome needs a named reviewer and a reason,
 * including rejection: "we checked and the association is correct" is what the
 * person is owed. */
export function planDisputeResolution({ outcome, reviewer, note } = {}) {
  if (!OUTCOMES.has(outcome)) return Object.freeze({ ok: false, error: 'outcome_invalid' });
  if (typeof reviewer !== 'string' || !reviewer.trim()) return Object.freeze({ ok: false, error: 'reviewer_required' });
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (!trimmed) return Object.freeze({ ok: false, error: 'note_required' });
  if (trimmed.length > 5000) return Object.freeze({ ok: false, error: 'note_too_long' });
  return Object.freeze({ ok: true, outcome, reviewer: reviewer.trim(), note: trimmed, allowedFrom: OPEN_DISPUTE_STATUSES });
}

/**
 * Marks evidence rows that are under an open dispute, directly or through
 * their actor, so the integrity layer can keep them out of public states and
 * high-impact actions without dropping them from internal scoring.
 */
export function markDisputedEvidence(evidence, openDisputes = []) {
  const disputedEvidence = new Set();
  const disputedActors = new Set();
  for (const dispute of openDisputes) {
    if (!OPEN_DISPUTE_STATUSES.includes(dispute?.status ?? 'open')) continue;
    if (dispute.evidenceId) disputedEvidence.add(Number(dispute.evidenceId));
    // Every type except a single piece of evidence calls the actor's identity
    // itself into question, and with it everything attributed to the actor.
    if (dispute.actorId && dispute.disputeType !== 'incorrect_risk_evidence') disputedActors.add(Number(dispute.actorId));
  }
  return (evidence ?? []).map((row) => ({
    ...row,
    underDispute: disputedEvidence.has(Number(row.id)) || disputedActors.has(Number(row.actorId)),
  }));
}
