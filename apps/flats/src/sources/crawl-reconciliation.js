import {pool} from '../infrastructure/database/pool.js';
import { deleteListingDocuments } from '../infrastructure/search/elasticsearch.js';
import { olxSegmentDealType } from '../geo/olx-segment.js';
import {
  classifyScanOutcome,
  planInventoryReconciliation,
  DEFAULT_EMPTY_CONFIRMATIONS,
} from './scan-confidence.js';

/**
 * Reconcile an authoritative all-country OLX segment after its page chain ends.
 *
 * A page-chain is sequential: page N+1 is enqueued only after page N succeeds.
 * Therefore reaching the terminal page means every earlier page in this segment
 * completed successfully. We deliberately run this only for the all-country
 * chain (citySlug == null in queueTasks), because city-specific chains overlap
 * and must never deactivate listings owned by another locality crawl.
 *
 * Reaching the end of the chain proves the crawler stopped, not that the source
 * was healthy: a site under maintenance or behind an anti-bot wall returns
 * well-formed empty pages and terminates on page one. Every finished scan is
 * therefore classified (see scan-confidence.js) and only `complete` or
 * `confirmed-empty` scans may deactivate anything. The availability probe
 * remains a second, independent safety net between crawls.
 */
export async function reconcileAuthoritativeOlxSegment({
  country,
  segment,
  crawlGeneration,
  observedCount = null,
  errored = false,
  pageLimitReached = false,
  terminal = true,
}) {
  const normalizedCountry = String(country || '').trim().toUpperCase();
  const normalizedSegment = String(segment || '').trim();
  const generation = String(crawlGeneration || '').trim();
  const dealType = olxSegmentDealType(normalizedSegment);

  if (!normalizedCountry || !generation || !dealType) {
    return { reconciled: false, deactivated: [], reason: 'invalid_scope' };
  }

  const generationStart = await pool.query(
    `
      SELECT MIN(created_at) AS started_at
      FROM crawl_tasks
      WHERE crawl_generation = $1
        AND type = 'flat.olx.page'
        AND country = $2
        AND payload->>'segment' = $3
        AND COALESCE(payload->>'citySlug', '') = ''
    `,
    [generation, normalizedCountry, normalizedSegment],
  );

  const startedAt = generationStart.rows[0]?.started_at;
  if (!startedAt) {
    return { reconciled: false, deactivated: [], reason: 'generation_start_missing' };
  }

  // What this scope currently holds, and how much of it this crawl did not see.
  const counts = await pool.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE active) AS known_active,
        COUNT(*) FILTER (WHERE active AND last_seen_at >= $3::timestamptz) AS observed,
        COUNT(*) FILTER (WHERE active AND last_seen_at < $3::timestamptz) AS stale
      FROM listings
      WHERE source = 'olx' AND country = $1 AND deal_type = $2
    `,
    [normalizedCountry, dealType, startedAt],
  );
  const knownActiveCount = Number(counts.rows[0]?.known_active ?? 0);
  const staleCount = Number(counts.rows[0]?.stale ?? 0);
  const seen = observedCount === null ? Number(counts.rows[0]?.observed ?? 0) : Number(observedCount);

  const priorEmpty = await pool.query(
    `
      SELECT observed_at
      FROM source_scan_runs
      WHERE source = 'olx' AND country = $1 AND scope = $2
        AND state IN ('suspect-empty', 'confirmed-empty')
        AND crawl_generation IS DISTINCT FROM $3
      ORDER BY observed_at DESC
      LIMIT $4
    `,
    [normalizedCountry, normalizedSegment, generation, DEFAULT_EMPTY_CONFIRMATIONS * 4],
  );

  const outcome = classifyScanOutcome({
    observedCount: seen,
    knownActiveCount,
    terminal,
    pageLimitReached,
    errored,
    priorEmptyRuns: priorEmpty.rows.map((row) => ({ observedAt: row.observed_at })),
  });
  const plan = planInventoryReconciliation(outcome, { staleCount, knownActiveCount });

  let deactivated = [];
  if (plan.deactivate) {
    const result = await pool.query(
      `
        UPDATE listings
        SET
          active = FALSE,
          missed_runs = missed_runs + 1,
          availability_checked_at = NOW(),
          availability_status = 'inactive',
          availability_reason = 'missing_from_complete_crawl',
          updated_at = NOW()
        WHERE source = 'olx'
          AND country = $1
          AND deal_type = $2
          AND active = TRUE
          AND last_seen_at < $3::timestamptz
        RETURNING source, country, source_id
      `,
      [normalizedCountry, dealType, startedAt],
    );
    deactivated = result.rows.map((row) => ({
      source: row.source,
      country: row.country,
      id: String(row.source_id),
    }));
  }

  await recordScanRun({
    country: normalizedCountry,
    scope: normalizedSegment,
    generation,
    outcome,
    observedCount: seen,
    knownActiveCount,
    staleCount,
    deactivatedCount: deactivated.length,
  });

  if (deactivated.length) {
    try {
      await deleteListingDocuments(deactivated);
    } catch (error) {
      console.warn(
        `[crawl:reconcile] failed to remove ${deactivated.length} stale OLX documents ` +
        `from Elasticsearch: ${error?.message ?? error}`,
      );
    }

    console.log(
      `[crawl:reconcile] OLX ${normalizedCountry}/${normalizedSegment}: ` +
      `${deactivated.length} stale listings deactivated`,
    );
  } else if (!plan.deactivate && staleCount > 0) {
    console.warn(
      `[crawl:reconcile] OLX ${normalizedCountry}/${normalizedSegment}: kept ${staleCount} ` +
      `stale listings (${outcome.state}: ${plan.reason})`,
    );
  }

  return {
    reconciled: true,
    startedAt: new Date(startedAt).toISOString(),
    dealType,
    deactivated,
    scanState: outcome.state,
    scanReason: outcome.reason,
    emptyStreak: outcome.emptyStreak ?? 0,
    knownActiveCount,
    staleCount,
    skippedReason: plan.deactivate ? null : plan.reason,
  };
}

/** Best-effort: a scan is still reconciled even if its audit row fails. */
async function recordScanRun({ country, scope, generation, outcome, observedCount, knownActiveCount, staleCount, deactivatedCount }) {
  try {
    await pool.query(
      `
        INSERT INTO source_scan_runs
          (source, country, scope, crawl_generation, state, reason,
           observed_count, known_active_count, stale_count, deactivated_count, empty_streak)
        VALUES ('olx', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (source, country, scope, crawl_generation)
          DO UPDATE SET
            state = EXCLUDED.state,
            reason = EXCLUDED.reason,
            observed_count = EXCLUDED.observed_count,
            known_active_count = EXCLUDED.known_active_count,
            stale_count = EXCLUDED.stale_count,
            deactivated_count = EXCLUDED.deactivated_count,
            empty_streak = EXCLUDED.empty_streak,
            observed_at = NOW()
      `,
      [country, scope, generation, outcome.state, outcome.reason,
        observedCount, knownActiveCount, staleCount, deactivatedCount, outcome.emptyStreak ?? 0],
    );
  } catch (error) {
    console.warn(`[crawl:reconcile] failed to record scan run: ${error?.message ?? error}`);
  }
}
