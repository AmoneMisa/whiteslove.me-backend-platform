// Retention for Telegram subscription data (docs/privacy/RETENTION_POLICY_DRAFT.md).
//
// Personal data here is a subscriber's Telegram id, chat, username, first name
// and saved searches. The policy:
//   - someone with no subscriptions left (all unsubscribed) is deleted after a
//     30-day grace period without interaction;
//   - someone whose subscriptions are all paused is deleted after 12 months
//     without interaction;
//   - delivery history is kept 12 months (it only prevents re-sending);
//   - expired edit sessions and site handoffs are deleted a day after expiry.
//
// Personal-data deletion runs only once PRIVACY_RETENTION_POLICY_APPROVED names
// this exact policy version, the same gate as the flats retention executor.
// Expired one-time tokens are not personal data and are always cleaned up.

/** Must equal RETENTION_POLICY_VERSION in apps/flats/src/privacy/retention-policy.js
 * (a test keeps them in step). */
export const RETENTION_POLICY_VERSION = '2026-09-draft-1';

export const UNSUBSCRIBED_GRACE_DAYS = 30;
export const PAUSED_INACTIVE_DAYS = 365;
export const DELIVERY_HISTORY_DAYS = 365;

export function retentionApproved(env = process.env) {
  return String(env.PRIVACY_RETENTION_POLICY_APPROVED ?? '').trim() === RETENTION_POLICY_VERSION;
}

/**
 * One retention pass. Each statement deletes a bounded batch, so a large
 * backlog is worked through over several passes instead of one long lock.
 */
export async function runSubscriptionRetention(client, schema, { env = process.env, batchSize = 1000 } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('invalid schema');
  const size = Math.min(10_000, Math.max(1, Math.floor(Number(batchSize) || 1000)));

  const tokens = await client.query(
    `
      WITH sessions AS (
        DELETE FROM ${schema}.edit_sessions
        WHERE token IN (SELECT token FROM ${schema}.edit_sessions WHERE expires_at < NOW() - INTERVAL '1 day' LIMIT $1)
        RETURNING 1
      ),
      handoffs AS (
        DELETE FROM ${schema}.handoffs
        WHERE token IN (SELECT token FROM ${schema}.handoffs WHERE expires_at < NOW() - INTERVAL '1 day' LIMIT $1)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM sessions)::int AS sessions, (SELECT count(*) FROM handoffs)::int AS handoffs
    `,
    [size],
  );

  const report = {
    approved: retentionApproved(env),
    expiredSessions: tokens.rows[0]?.sessions ?? 0,
    expiredHandoffs: tokens.rows[0]?.handoffs ?? 0,
    users: 0,
    deliveries: 0,
  };
  if (!report.approved) return report;

  // Subscriptions, seen-items and (via SET NULL) delivery links cascade from
  // the user row. "Interaction" is the later of the user's own last update and
  // any change to their subscriptions.
  const users = await client.query(
    `
      DELETE FROM ${schema}.users u
      WHERE u.telegram_user_id IN (
        SELECT candidate.telegram_user_id
        FROM ${schema}.users candidate
        LEFT JOIN LATERAL (
          SELECT count(*) AS total,
                 count(*) FILTER (WHERE s.enabled) AS enabled,
                 max(s.updated_at) AS last_change
          FROM ${schema}.subscriptions s
          WHERE s.telegram_user_id = candidate.telegram_user_id
        ) subs ON TRUE
        WHERE (subs.total = 0
               AND GREATEST(candidate.updated_at, COALESCE(subs.last_change, candidate.updated_at))
                   < NOW() - make_interval(days => $2::int))
           OR (subs.total > 0 AND subs.enabled = 0
               AND GREATEST(candidate.updated_at, COALESCE(subs.last_change, candidate.updated_at))
                   < NOW() - make_interval(days => $3::int))
        LIMIT $1
      )
    `,
    [size, UNSUBSCRIBED_GRACE_DAYS, PAUSED_INACTIVE_DAYS],
  );
  report.users = users.rowCount ?? 0;

  // Delivery history has no foreign key to users, so rows of deleted users and
  // rows past the history period go here; deliveries_sent_idx serves the range.
  const deliveries = await client.query(
    `
      DELETE FROM ${schema}.deliveries d
      WHERE d.ctid IN (
        SELECT x.ctid FROM ${schema}.deliveries x
        WHERE x.sent_at < NOW() - make_interval(days => $2::int)
           OR NOT EXISTS (SELECT 1 FROM ${schema}.users u WHERE u.telegram_user_id = x.telegram_user_id)
        LIMIT $1
      )
    `,
    [size, DELIVERY_HISTORY_DAYS],
  );
  report.deliveries = deliveries.rowCount ?? 0;
  return report;
}
