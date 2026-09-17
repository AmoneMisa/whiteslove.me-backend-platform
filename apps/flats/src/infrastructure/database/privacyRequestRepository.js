import { pool } from './pool.js';
import {
  newRequestReference, requestDueAt, planStatusTransition, planIdentifierVerification, OPEN_STATUSES,
} from '../../privacy/privacy-requests.js';
import { planDisputeResolution, OPEN_DISPUTE_STATUSES } from '../../privacy/disputes.js';

/**
 * Persistence for privacy requests, disputes and processing restrictions.
 *
 * Same rules as the review repository: every state change and its audit row
 * are one statement, and every transition is checked against the row's state
 * at update time, so concurrent or stale actions return `conflict` instead of
 * overwriting each other.
 */

const MAX_PAGE = 100;
const pageSize = (limit) => Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit) || 50)));
const positiveId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

/** Stores a validated intake. Returns only what the requester may be told. */
export async function createPrivacyRequest(request, { now = new Date() } = {}, client = pool) {
  const reference = newRequestReference();
  const result = await client.query(
    `
      INSERT INTO platform.privacy_requests
        (reference, request_type, requester_email, claimed_identifiers, details, received_at, due_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      RETURNING reference, status, due_at
    `,
    [reference, request.requestType, request.requesterEmail, JSON.stringify(request.claimedIdentifiers), request.details, now, requestDueAt(now)],
  );
  const row = result.rows[0];
  return { reference: row.reference, status: row.status, dueAt: row.due_at };
}

/**
 * Public status lookup by reference. Deliberately returns nothing about the
 * request's content: the reference is a bearer token, and whoever holds it
 * learns only where the request stands.
 */
export async function findPrivacyRequestStatus(reference, client = pool) {
  if (typeof reference !== 'string' || !/^PR-[A-Za-z0-9_-]{20}$/u.test(reference)) return null;
  const result = await client.query(
    'SELECT status, due_at, closed_at FROM platform.privacy_requests WHERE reference = $1',
    [reference],
  );
  const row = result.rows[0];
  return row ? { status: row.status, dueAt: row.due_at, closedAt: row.closed_at } : null;
}

/** Open requests, nearest deadline first, keyset-paginated on the partial index. */
export async function listOpenPrivacyRequests({ limit = 50, after = null } = {}, client = pool) {
  const size = pageSize(limit);
  const params = [size + 1];
  let cursor = '';
  if (after && positiveId(after.id)) {
    params.push(after.dueAt, positiveId(after.id));
    cursor = 'AND (due_at, id) > ($2::timestamptz, $3::bigint)';
  }
  const result = await client.query(
    `
      SELECT id, reference, request_type, status, requester_email, claimed_identifiers,
             verified_identifiers, verification_method, details, received_at, due_at, extension_reason
      FROM platform.privacy_requests
      WHERE status IN ('received', 'identity_verification_required', 'in_review') ${cursor}
      ORDER BY due_at, id
      LIMIT $1
    `,
    params,
  );
  const items = result.rows.slice(0, size).map(mapRequest);
  const last = items.at(-1);
  return { items, next: result.rows.length > size && last ? { dueAt: last.dueAt, id: last.id } : null };
}

export async function getPrivacyRequest(id, client = pool) {
  const requestId = positiveId(id);
  if (!requestId) return null;
  const result = await client.query(
    `
      SELECT id, reference, request_type, status, requester_email, claimed_identifiers,
             verified_identifiers, verification_method, details, received_at, due_at, extension_reason,
             resolution_reason, closed_at
      FROM platform.privacy_requests
      WHERE id = $1
    `,
    [requestId],
  );
  return result.rows[0] ? mapRequest(result.rows[0]) : null;
}

/** Moves a request to a new status, with its audit event, atomically. */
export async function transitionPrivacyRequest({ id, to, reviewer, reason } = {}, client = pool) {
  const requestId = positiveId(id);
  if (!requestId) return { ok: false, error: 'invalid_request_id' };
  const plan = planStatusTransition({ to, reviewer, reason });
  if (!plan.ok) return plan;
  const result = await client.query(
    `
      WITH previous AS (
        SELECT id, status FROM platform.privacy_requests WHERE id = $1 FOR UPDATE
      ),
      updated AS (
        UPDATE platform.privacy_requests r
        SET status = $2,
            resolution_reason = COALESCE($4, r.resolution_reason),
            closed_at = CASE WHEN $5::boolean THEN NOW() ELSE r.closed_at END,
            updated_at = NOW()
        FROM previous p
        WHERE r.id = p.id AND p.status = ANY($6::varchar[])
        RETURNING r.id, p.status AS from_state, r.status AS to_state
      ),
      audited AS (
        INSERT INTO platform.review_audit_events (subject_type, subject_id, action, from_state, to_state, reviewer, note)
        SELECT 'privacy_request', id, 'transition', from_state, to_state, $3, $4 FROM updated
        RETURNING subject_id
      )
      SELECT u.id, u.from_state, u.to_state FROM updated u JOIN audited a ON a.subject_id = u.id
    `,
    [requestId, plan.to, plan.reviewer, plan.reason, plan.closes, [...plan.allowedFrom]],
  );
  const row = result.rows[0];
  return row ? { ok: true, id: Number(row.id), from: row.from_state, to: row.to_state } : { ok: false, error: 'conflict' };
}

/**
 * Records verified identifiers. Takes the claimed list from the row itself,
 * under lock, so a reviewer cannot verify an identifier the requester never
 * claimed.
 */
export async function verifyRequestIdentifiers({ id, identifiers, method, reviewer } = {}, client = pool) {
  const requestId = positiveId(id);
  if (!requestId) return { ok: false, error: 'invalid_request_id' };
  const current = await client.query(
    'SELECT claimed_identifiers, status FROM platform.privacy_requests WHERE id = $1',
    [requestId],
  );
  const row = current.rows[0];
  if (!row) return { ok: false, error: 'conflict' };
  const plan = planIdentifierVerification({ claimed: row.claimed_identifiers ?? [], verified: identifiers ?? [], method, reviewer });
  if (!plan.ok) return plan;

  const result = await client.query(
    `
      WITH updated AS (
        UPDATE platform.privacy_requests
        SET verified_identifiers = $2::jsonb,
            verification_method = $3,
            updated_at = NOW()
        WHERE id = $1
          AND status = ANY($5::varchar[])
          -- Re-checked under the update: the claim list cannot have changed
          -- between the read above and this write.
          AND claimed_identifiers @> $2::jsonb
        RETURNING id
      ),
      audited AS (
        INSERT INTO platform.review_audit_events (subject_type, subject_id, action, reviewer, note)
        SELECT 'privacy_request', id, 'verify', $4, $3 FROM updated
        RETURNING subject_id
      )
      SELECT subject_id FROM audited
    `,
    [requestId, JSON.stringify(plan.identifiers), plan.method, plan.reviewer, [...OPEN_STATUSES]],
  );
  return result.rows[0] ? { ok: true, id: requestId, verified: plan.identifiers.length } : { ok: false, error: 'conflict' };
}

/**
 * Everything held for a set of verified identifiers, in four queries however
 * many identifiers there are. The contact lookup joins an unnest of
 * (type, value) pairs against the unique index on contact_points.
 */
export async function findSubjectRecords(verifiedIdentifiers, client = pool) {
  const identifiers = (verifiedIdentifiers ?? []).filter((item) => item?.type && item?.value);
  if (!identifiers.length) return { contactPoints: [], actors: [], platformIdentities: [], evidence: [] };

  const contacts = await client.query(
    `
      SELECT c.id, c.type, c.canonical_value, c.origin, c.source_ref, c.publicly_accessible, c.first_seen_at, c.last_seen_at
      FROM unnest($1::varchar[], $2::text[]) AS i(type, value)
      JOIN platform.contact_points c ON c.type = i.type AND c.canonical_value = i.value
    `,
    [identifiers.map((item) => item.type), identifiers.map((item) => item.value)],
  );
  const contactIds = contacts.rows.map((row) => Number(row.id));
  if (!contactIds.length) return { contactPoints: [], actors: [], platformIdentities: [], evidence: [] };

  // Actors reached through those contacts, with *all* their contact links so
  // the scoping step can see and withhold contacts that are not the
  // requester's.
  const actors = await client.query(
    `
      WITH reached AS (
        SELECT DISTINCT actor_id FROM platform.actor_contact_points WHERE contact_point_id = ANY($1::bigint[])
      )
      SELECT a.id, a.first_seen_at, a.last_seen_at,
             ARRAY(SELECT contact_point_id FROM platform.actor_contact_points l WHERE l.actor_id = a.id) AS contact_point_ids,
             ARRAY(SELECT role FROM platform.actor_roles r WHERE r.actor_id = a.id) AS roles
      FROM reached JOIN platform.actor_identities a ON a.id = reached.actor_id
    `,
    [contactIds],
  );
  const actorIds = actors.rows.map((row) => Number(row.id));

  const requested = new Set(contactIds);
  const otherContactIds = [...new Set(actors.rows.flatMap((row) => (row.contact_point_ids ?? []).map(Number)))]
    .filter((contactId) => !requested.has(contactId));
  const others = otherContactIds.length
    ? await client.query('SELECT id, type, canonical_value FROM platform.contact_points WHERE id = ANY($1::bigint[])', [otherContactIds])
    : { rows: [] };

  const [identities, evidence] = actorIds.length
    ? await Promise.all([
      client.query(
        `SELECT actor_id, platform, username, display_name, first_observed_at, last_observed_at
         FROM platform.platform_identities WHERE actor_id = ANY($1::bigint[])`,
        [actorIds],
      ),
      client.query(
        `SELECT actor_id, polarity, reason_code, dimension, independent_count, review_state, first_observed_at, last_observed_at
         FROM platform.actor_evidence WHERE actor_id = ANY($1::bigint[])`,
        [actorIds],
      ),
    ])
    : [{ rows: [] }, { rows: [] }];

  return {
    contactPoints: [...contacts.rows, ...others.rows].map((row) => ({
      id: Number(row.id),
      type: row.type,
      canonicalValue: row.canonical_value,
      origin: row.origin ?? null,
      sourceRef: row.source_ref ?? null,
      publiclyAccessible: row.publicly_accessible ?? null,
      firstSeenAt: row.first_seen_at ?? null,
      lastSeenAt: row.last_seen_at ?? null,
    })),
    actors: actors.rows.map((row) => ({
      id: Number(row.id),
      contactPointIds: (row.contact_point_ids ?? []).map(Number),
      roles: row.roles ?? [],
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    })),
    platformIdentities: identities.rows.map((row) => ({
      actorId: Number(row.actor_id),
      platform: row.platform,
      username: row.username,
      displayName: row.display_name,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
    })),
    evidence: evidence.rows.map((row) => ({
      actorId: Number(row.actor_id),
      polarity: row.polarity,
      reasonCode: row.reason_code,
      dimension: row.dimension,
      independentCount: Number(row.independent_count),
      reviewState: row.review_state,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
    })),
  };
}

/**
 * Restricts processing (Article 18) or records an objection (Article 21) for
 * actors and contact points, with one audit row per subject, in one statement.
 */
export async function restrictProcessing({ actorIds = [], contactPointIds = [], kind = 'restriction', reviewer, note } = {}, client = pool) {
  if (!['restriction', 'objection'].includes(kind)) return { ok: false, error: 'kind_invalid' };
  if (typeof reviewer !== 'string' || !reviewer.trim()) return { ok: false, error: 'reviewer_required' };
  const actors = [...new Set(actorIds.map(positiveId).filter(Boolean))];
  // An objection is about processing of the person, which is keyed on the
  // actor; contact points only carry restriction.
  const contacts = kind === 'restriction' ? [...new Set(contactPointIds.map(positiveId).filter(Boolean))] : [];
  if (!actors.length && !contacts.length) return { ok: false, error: 'subject_required' };
  const column = kind === 'objection' ? 'processing_objection_at' : 'processing_restricted_at';

  const result = await client.query(
    `
      WITH actors AS (
        UPDATE platform.actor_identities SET ${column} = COALESCE(${column}, NOW())
        WHERE id = ANY($1::bigint[])
        RETURNING id
      ),
      contacts AS (
        UPDATE platform.contact_points SET processing_restricted_at = COALESCE(processing_restricted_at, NOW())
        WHERE id = ANY($2::bigint[])
        RETURNING id
      ),
      audited AS (
        INSERT INTO platform.review_audit_events (subject_type, subject_id, action, to_state, reviewer, note)
        SELECT 'actor', id, $3, 'restricted', $4, $5 FROM actors
        UNION ALL
        SELECT 'contact_point', id, $3, 'restricted', $4, $5 FROM contacts
        RETURNING subject_type
      )
      SELECT subject_type, count(*)::int AS affected FROM audited GROUP BY subject_type
    `,
    [actors, contacts, kind, reviewer.trim(), typeof note === 'string' && note.trim() ? note.trim() : null],
  );
  const affected = Object.fromEntries(result.rows.map((row) => [row.subject_type, row.affected]));
  return { ok: true, actors: affected.actor ?? 0, contactPoints: affected.contact_point ?? 0 };
}

/** Opens a dispute case from a validated dispute. */
export async function createDisputeCase(dispute, client = pool) {
  const result = await client.query(
    `
      INSERT INTO platform.dispute_cases
        (privacy_request_id, dispute_type, actor_id, contact_point_id, evidence_id, property_cluster_id, statement)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, status, created_at
    `,
    [dispute.privacyRequestId, dispute.disputeType, dispute.actorId, dispute.contactPointId, dispute.evidenceId, dispute.propertyClusterId, dispute.statement],
  );
  const row = result.rows[0];
  return { id: Number(row.id), status: row.status, createdAt: row.created_at };
}

/** Open disputes touching any of these actors or evidence rows: one query,
 * both probes served by partial indexes. */
export async function findOpenDisputes({ actorIds = [], evidenceIds = [] } = {}, client = pool) {
  const actors = [...new Set(actorIds.map(positiveId).filter(Boolean))];
  const evidence = [...new Set(evidenceIds.map(positiveId).filter(Boolean))];
  if (!actors.length && !evidence.length) return [];
  const result = await client.query(
    `
      SELECT id, dispute_type, actor_id, evidence_id, status
      FROM platform.dispute_cases
      WHERE status IN ('open', 'in_review')
        AND (actor_id = ANY($1::bigint[]) OR evidence_id = ANY($2::bigint[]))
    `,
    [actors, evidence],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    disputeType: row.dispute_type,
    actorId: row.actor_id === null ? null : Number(row.actor_id),
    evidenceId: row.evidence_id === null ? null : Number(row.evidence_id),
    status: row.status,
  }));
}

/** Resolves a dispute with its audit event, atomically. */
export async function resolveDisputeCase({ id, outcome, reviewer, note } = {}, client = pool) {
  const disputeId = positiveId(id);
  if (!disputeId) return { ok: false, error: 'invalid_dispute_id' };
  const plan = planDisputeResolution({ outcome, reviewer, note });
  if (!plan.ok) return plan;
  const result = await client.query(
    `
      WITH previous AS (
        SELECT id, status FROM platform.dispute_cases WHERE id = $1 FOR UPDATE
      ),
      updated AS (
        UPDATE platform.dispute_cases d
        SET status = $2, resolution_note = $4, resolved_by = $3, closed_at = NOW(), updated_at = NOW()
        FROM previous p
        WHERE d.id = p.id AND p.status = ANY($5::varchar[])
        RETURNING d.id, p.status AS from_state, d.status AS to_state
      ),
      audited AS (
        INSERT INTO platform.review_audit_events (subject_type, subject_id, action, from_state, to_state, reviewer, note)
        SELECT 'dispute_case', id, 'resolve', from_state, to_state, $3, $4 FROM updated
        RETURNING subject_id
      )
      SELECT u.id, u.from_state, u.to_state FROM updated u JOIN audited a ON a.subject_id = u.id
    `,
    [disputeId, plan.outcome, plan.reviewer, plan.note, [...OPEN_DISPUTE_STATUSES]],
  );
  const row = result.rows[0];
  return row ? { ok: true, id: Number(row.id), from: row.from_state, to: row.to_state } : { ok: false, error: 'conflict' };
}

function mapRequest(row) {
  return {
    id: Number(row.id),
    reference: row.reference,
    requestType: row.request_type,
    status: row.status,
    requesterEmail: row.requester_email,
    claimedIdentifiers: row.claimed_identifiers ?? [],
    verifiedIdentifiers: row.verified_identifiers ?? [],
    verificationMethod: row.verification_method ?? null,
    details: row.details ?? null,
    receivedAt: row.received_at,
    dueAt: row.due_at,
    extensionReason: row.extension_reason ?? null,
    resolutionReason: row.resolution_reason ?? null,
    closedAt: row.closed_at ?? null,
  };
}
