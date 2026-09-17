import { pool } from './pool.js';
import { planReviewAction } from '../../identity/integrity-scores.js';

/**
 * Review queue and review actions over platform.actor_evidence (§36).
 *
 * Two properties matter more than anything else here:
 *
 *  1. A decision and its audit record are one statement. Writing the state and
 *     then the audit row as two round trips would leave, on a crash or a lost
 *     connection between them, a decision nobody can account for.
 *
 *  2. The transition is checked against the row's state *at update time*, not
 *     at the time the reviewer loaded the page. Two reviewers acting on the same
 *     row cannot both succeed, and neither can apply a transition from a state
 *     the row has already left. A rejected action returns `conflict` rather
 *     than silently overwriting a colleague's decision.
 */

const MAX_PAGE = 100;

/**
 * One page of the queue, strongest and most recent first.
 *
 * Keyset pagination on (independent_count, last_observed_at, id), which is
 * exactly the partial index from migration 054: every page is an index range
 * scan however deep the reviewer goes, where OFFSET would read and discard
 * every earlier row.
 */
export async function listReviewQueue({ limit = 50, after = null } = {}, client = pool) {
  const size = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit) || 50)));
  const params = [size + 1];
  let cursor = '';
  if (after && Number.isFinite(Number(after.id))) {
    params.push(Number(after.independentCount), after.lastObservedAt, Number(after.id));
    // Row comparison with every column descending, so it matches the index
    // order and Postgres can start the scan at the cursor.
    cursor = 'AND (independent_count, last_observed_at, id) < ($2::int, $3::timestamptz, $4::bigint)';
  }
  const result = await client.query(
    `
      SELECT id, actor_id, polarity, reason_code, dimension, independent_count,
             detail, review_state, reviewed_by, reviewed_at, first_observed_at, last_observed_at
      FROM platform.actor_evidence
      WHERE review_state IN ('open', 'watch') ${cursor}
      ORDER BY independent_count DESC, last_observed_at DESC, id DESC
      LIMIT $1
    `,
    params,
  );
  const rows = result.rows.slice(0, size).map(mapEvidence);
  const last = rows.at(-1);
  return {
    items: rows,
    // One extra row was fetched to know whether another page exists without a
    // separate COUNT, which on a large queue is the expensive query.
    next: result.rows.length > size && last
      ? { independentCount: last.independentCount, lastObservedAt: last.lastObservedAt, id: last.id }
      : null,
  };
}

/** All evidence for a batch of actors, both polarities, in one query. */
export async function loadActorEvidence(actorIds, client = pool) {
  const ids = [...new Set((actorIds ?? []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();
  const result = await client.query(
    `
      SELECT e.id, e.actor_id, e.polarity, e.reason_code, e.dimension, e.independent_count,
             e.detail, e.review_state, e.reviewed_by, e.reviewed_at, e.first_observed_at, e.last_observed_at,
             -- Scoring still sees the evidence, but integrity-scores keeps
             -- restricted subjects out of public states and actions.
             (a.processing_restricted_at IS NOT NULL OR a.processing_objection_at IS NOT NULL) AS processing_restricted
      FROM platform.actor_evidence e
      JOIN platform.actor_identities a ON a.id = e.actor_id
      WHERE e.actor_id = ANY($1::bigint[])
    `,
    [ids],
  );
  const byActor = new Map();
  for (const row of result.rows) {
    const evidence = mapEvidence(row);
    const bucket = byActor.get(evidence.actorId);
    if (bucket) bucket.push(evidence);
    else byActor.set(evidence.actorId, [evidence]);
  }
  return byActor;
}

/**
 * Applies approve / reject / watch / resolve / reopen to one evidence row and
 * records it, atomically.
 *
 * Returns `{ ok: true, evidenceId, from, to }`, `{ ok: false, error }` for an
 * invalid request, or `{ ok: false, error: 'conflict' }` when the row is gone
 * or no longer in a state the action may leave.
 */
export async function applyReviewAction({ evidenceId, action, reviewer, note } = {}, client = pool) {
  const id = Number(evidenceId);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'invalid_evidence_id' };
  const plan = planReviewAction({ action, reviewer, note });
  if (!plan.ok) return plan;

  const result = await client.query(
    `
      WITH previous AS (
        -- Lock the row so the state read here is the state updated below.
        SELECT id, review_state
        FROM platform.actor_evidence
        WHERE id = $1
        FOR UPDATE
      ),
      updated AS (
        UPDATE platform.actor_evidence e
        SET review_state = $2,
            reviewed_by = $3,
            reviewed_at = NOW()
        FROM previous p
        WHERE e.id = p.id
          AND p.review_state = ANY($4::varchar[])
        RETURNING e.id, p.review_state AS from_state, e.review_state AS to_state
      ),
      audited AS (
        INSERT INTO platform.review_audit_events (subject_type, subject_id, action, from_state, to_state, reviewer, note)
        SELECT 'actor_evidence', id, $5, from_state, to_state, $3, $6
        FROM updated
        RETURNING subject_id
      )
      SELECT u.id, u.from_state, u.to_state
      FROM updated u
      JOIN audited a ON a.subject_id = u.id
    `,
    [id, plan.to, plan.reviewer, [...plan.from], plan.action, plan.note],
  );

  const row = result.rows[0];
  if (!row) return { ok: false, error: 'conflict' };
  return { ok: true, evidenceId: Number(row.id), from: row.from_state, to: row.to_state };
}

/** Audit history of one subject, newest first, served by the subject index. */
export async function listReviewHistory({ subjectType = 'actor_evidence', subjectId, limit = 50 } = {}, client = pool) {
  const id = Number(subjectId);
  if (!Number.isSafeInteger(id)) return [];
  const result = await client.query(
    `
      SELECT id, subject_type, subject_id, action, from_state, to_state, reviewer, note, created_at
      FROM platform.review_audit_events
      WHERE subject_type = $1 AND subject_id = $2
      ORDER BY id DESC
      LIMIT $3
    `,
    [subjectType, id, Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit) || 50)))],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    subjectType: row.subject_type,
    subjectId: Number(row.subject_id),
    action: row.action,
    from: row.from_state,
    to: row.to_state,
    reviewer: row.reviewer,
    note: row.note,
    createdAt: row.created_at,
  }));
}

function mapEvidence(row) {
  return {
    id: Number(row.id),
    actorId: Number(row.actor_id),
    polarity: row.polarity,
    reasonCode: row.reason_code,
    dimension: row.dimension,
    independentCount: Number(row.independent_count),
    detail: row.detail ?? {},
    reviewState: row.review_state,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ?? null,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    ...(row.processing_restricted === true ? { processingRestricted: true } : {}),
  };
}

export const __integrityReviewTest = { mapEvidence, MAX_PAGE };
