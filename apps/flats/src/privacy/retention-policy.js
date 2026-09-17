/**
 * Retention by data class (§53, GDPR Article 5(1)(e)).
 *
 * This is a DRAFT policy. The periods are proposals for the operator to
 * approve, change or reject; they are not legal advice and nothing here runs
 * until the policy is explicitly approved. §53 says retention jobs are
 * implemented only after approval, so the executor refuses to delete anything
 * unless PRIVACY_RETENTION_POLICY_APPROVED names this exact policy version --
 * approving one version does not silently approve later edits to it.
 *
 * Nothing is kept "forever". Where a class is retained longer, the
 * justification is written next to it.
 */

export const RETENTION_POLICY_VERSION = '2026-09-draft-1';

export const RETENTION_ACTIONS = Object.freeze(['delete', 'anonymize', 'aggregate', 'retain_with_justification']);

const DAY = 1;
const MONTH = 30 * DAY;

/** Evidence under an open dispute survives retention until the dispute is
 * decided; deleting it would make the dispute impossible to check. */
const NOT_UNDER_DISPUTE = `NOT EXISTS (
      SELECT 1 FROM platform.dispute_cases d
      WHERE d.evidence_id = t.id AND d.status IN ('open', 'in_review')
    )`;

/**
 * One entry per data class. `table` and `timeColumn` are only set where the
 * class maps onto a platform table this module can safely act on; the rest
 * are documented here and enforced elsewhere (container log rotation, the
 * subscription bot, the workforce read models) or by manual procedure.
 */
export const RETENTION_CLASSES = Object.freeze([
  {
    dataClass: 'listing_snapshots_historical',
    description: 'Point-in-time copies of listings, including the linked contact',
    table: 'platform.listing_snapshots',
    timeColumn: 'observed_at',
    periodDays: 12 * MONTH,
    action: 'delete',
    justification: 'Repost and phantom-listing detection looks back months, not years; property_clusters keeps the aggregate counts.',
  },
  {
    dataClass: 'availability_observations',
    description: 'Probe and report outcomes for listings',
    table: 'platform.listing_availability_observations',
    timeColumn: 'observed_at',
    periodDays: 12 * MONTH,
    action: 'delete',
    justification: 'Availability-credibility evidence is derived and stored on the actor; the raw observations are not needed after a year.',
  },
  {
    dataClass: 'identity_alias_history',
    description: 'Past usernames, display names and bios of platform accounts',
    table: 'platform.platform_identity_observations',
    timeColumn: 'observed_at',
    periodDays: 12 * MONTH,
    action: 'delete',
    justification: 'Identity-churn detection uses a 30-day to 12-month window; older aliases are historical personal data with no remaining purpose.',
  },
  {
    dataClass: 'contact_points_unobserved',
    description: 'Phones and handles not seen in any listing for a long time',
    table: 'platform.contact_points',
    timeColumn: 'last_seen_at',
    periodDays: 18 * MONTH,
    action: 'delete',
    // A contact still attached to evidence under review must survive until the
    // review ends, or a dispute could never be checked against it.
    guard: `NOT EXISTS (
      SELECT 1 FROM platform.dispute_cases d
      WHERE d.contact_point_id = t.id AND d.status IN ('open', 'in_review')
    )`,
    justification: 'A number unseen for 18 months is no longer advertising anything.',
  },
  {
    dataClass: 'risk_evidence_dismissed',
    description: 'Risk evidence a reviewer rejected',
    table: 'platform.actor_evidence',
    timeColumn: 'last_observed_at',
    periodDays: 6 * MONTH,
    action: 'delete',
    guard: `t.review_state = 'dismissed' AND ${NOT_UNDER_DISPUTE}`,
    justification: 'Kept briefly so a rejected pattern re-observed straight away is recognised as already reviewed; then it is inaccurate data with no purpose.',
  },
  {
    dataClass: 'risk_evidence_unreviewed',
    description: 'Open or watched risk evidence not re-observed',
    table: 'platform.actor_evidence',
    timeColumn: 'last_observed_at',
    periodDays: 18 * MONTH,
    action: 'delete',
    guard: `t.polarity = 'risk' AND t.review_state IN ('open', 'watch', 'resolved') AND ${NOT_UNDER_DISPUTE}`,
    justification: 'Evidence that has not recurred in 18 months no longer describes current behaviour.',
  },
  {
    dataClass: 'risk_evidence_confirmed',
    description: 'Risk evidence a named reviewer confirmed',
    table: 'platform.actor_evidence',
    timeColumn: 'last_observed_at',
    periodDays: 36 * MONTH,
    action: 'retain_with_justification',
    guard: `t.polarity = 'risk' AND t.review_state = 'confirmed' AND ${NOT_UNDER_DISPUTE}`,
    justification: 'Human-confirmed findings protect later users from a returning actor; three years since last observation, then deleted. Requires legal review.',
  },
  {
    dataClass: 'trust_evidence',
    description: 'Positive evidence about an actor',
    table: 'platform.actor_evidence',
    timeColumn: 'last_observed_at',
    periodDays: 18 * MONTH,
    action: 'delete',
    guard: `t.polarity = 'trust' AND ${NOT_UNDER_DISPUTE}`,
    justification: 'Same horizon as unreviewed risk evidence, so trust is not retained longer than the risk it balances.',
  },
  {
    dataClass: 'review_audit_events',
    description: 'Who decided what about which evidence or request',
    table: 'platform.review_audit_events',
    timeColumn: 'created_at',
    periodDays: 36 * MONTH,
    action: 'retain_with_justification',
    justification: 'Accountability for decisions about people (Art 5(2)); must outlive the evidence it explains. Period requires legal review.',
  },
  {
    dataClass: 'privacy_requests_closed',
    description: 'Closed data-subject requests',
    table: 'platform.privacy_requests',
    timeColumn: 'closed_at',
    periodDays: 36 * MONTH,
    action: 'delete',
    guard: 't.closed_at IS NOT NULL',
    justification: 'Evidence that a request was handled, for the limitation period of a complaint. Period requires legal review.',
  },
  {
    dataClass: 'dispute_cases_closed',
    description: 'Resolved disputes',
    table: 'platform.dispute_cases',
    timeColumn: 'closed_at',
    periodDays: 36 * MONTH,
    action: 'delete',
    guard: 't.closed_at IS NOT NULL',
    justification: 'Same as privacy requests.',
  },
  {
    dataClass: 'scan_runs',
    description: 'Source crawl run statistics (no personal data)',
    table: 'source_scan_runs',
    timeColumn: 'observed_at',
    periodDays: 6 * MONTH,
    action: 'delete',
    justification: 'Operational metrics; recent history is all confidence scoring uses.',
  },
  // --- documented here, enforced elsewhere --------------------------------------
  {
    dataClass: 'listings_active',
    description: 'Current listings including the advertised contact',
    periodDays: null,
    action: 'retain_with_justification',
    justification: 'Kept while the listing is live at its source; removal handling is the existing listing lifecycle, then the historical-snapshot period applies.',
  },
  {
    dataClass: 'legacy_registry_import',
    description: 'Rows imported from the Google registry',
    periodDays: 18 * MONTH,
    action: 'delete',
    justification: 'Legacy labels not corroborated by any new observation within 18 months of import are dropped. Needs an executor once the import has run.',
  },
  {
    dataClass: 'subscription_accounts',
    description: 'Telegram subscription users and their saved searches',
    periodDays: 12 * MONTH,
    action: 'delete',
    justification: 'Deleted on unsubscribe; accounts with no enabled subscription for 12 months are removed. Enforced in apps/subscription-bot (not yet implemented).',
  },
  {
    dataClass: 'candidate_profiles',
    description: 'CV profiles collected from job sites',
    periodDays: 6 * MONTH,
    action: 'delete',
    justification: 'Kept while active at the source and six months after. Enforced in apps/workforce (not yet implemented).',
  },
  {
    dataClass: 'technical_logs',
    description: 'Container and reverse-proxy logs, which contain IP addresses',
    periodDays: 30 * DAY,
    action: 'delete',
    justification: 'Operational debugging only. Enforced by log rotation in the deployment, which must be configured and verified.',
  },
]);

/**
 * Whether the executor may act. Approval names a version, so editing the
 * policy after approval stops deletion until the new version is approved.
 */
export function retentionApproved(env = process.env) {
  return String(env.PRIVACY_RETENTION_POLICY_APPROVED ?? '').trim() === RETENTION_POLICY_VERSION;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/u;

/**
 * One bounded batch for a class, or null when the class has no executor.
 *
 * Deletes by primary key in batches rather than one statement, so a large
 * first run does not hold locks on a hot table for minutes or bloat WAL in one
 * transaction. The inner SELECT is a range scan on the time column (BRIN on
 * the append-only tables) and stops at the batch size.
 */
export function buildRetentionBatch(entry, { batchSize = 1000 } = {}) {
  if (!entry?.table || !entry.timeColumn || !Number.isFinite(entry.periodDays)) return null;
  if (!['delete', 'retain_with_justification'].includes(entry.action)) return null;
  if (!IDENTIFIER.test(entry.table) || !IDENTIFIER.test(entry.timeColumn)) throw new Error(`unsafe retention identifier for ${entry.dataClass}`);
  const size = Math.min(10_000, Math.max(1, Math.floor(Number(batchSize) || 1000)));
  const guard = entry.guard ? `AND ${entry.guard}` : '';
  return {
    dataClass: entry.dataClass,
    sql: `
      DELETE FROM ${entry.table}
      WHERE id IN (
        SELECT t.id FROM ${entry.table} t
        WHERE t.${entry.timeColumn} < NOW() - make_interval(days => $1::int)
          ${guard}
        LIMIT $2
      )
    `,
    params: [entry.periodDays, size],
  };
}

/**
 * Runs retention batches until each class is drained or the batch budget is
 * spent. Refuses entirely without approval of this exact version.
 */
export async function runRetention(client, { env = process.env, batchSize = 1000, maxBatchesPerClass = 50, classes = RETENTION_CLASSES } = {}) {
  if (!retentionApproved(env)) {
    return { ok: false, error: 'retention_policy_not_approved', version: RETENTION_POLICY_VERSION };
  }
  const report = [];
  for (const entry of classes) {
    const batch = buildRetentionBatch(entry, { batchSize });
    if (!batch) continue;
    let deleted = 0;
    let batches = 0;
    while (batches < maxBatchesPerClass) {
      const result = await client.query(batch.sql, batch.params);
      batches += 1;
      deleted += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < batch.params[1]) break;
    }
    report.push({ dataClass: entry.dataClass, deleted, batches, exhausted: batches >= maxBatchesPerClass });
  }
  return { ok: true, version: RETENTION_POLICY_VERSION, report };
}
