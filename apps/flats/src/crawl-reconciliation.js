import { pool } from './db.js';
import { deleteListingDocuments } from './elasticsearch.js';
import { olxSegmentDealType } from './olx-segment.js';

/**
 * Reconcile an authoritative all-country OLX segment after its page chain ends.
 *
 * A page-chain is sequential: page N+1 is enqueued only after page N succeeds.
 * Therefore reaching the terminal page means every earlier page in this segment
 * completed successfully. We deliberately run this only for the all-country
 * chain (citySlug == null in queueTasks), because city-specific chains overlap
 * and must never deactivate listings owned by another locality crawl.
 *
 * Listings not observed since the generation's first task for this segment are
 * outside the current crawler snapshot and can be deactivated immediately. The
 * availability probe remains a second, independent safety net between crawls.
 */
export async function reconcileAuthoritativeOlxSegment({
  country,
  segment,
  crawlGeneration,
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

  const deactivated = result.rows.map((row) => ({
    source: row.source,
    country: row.country,
    id: String(row.source_id),
  }));

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
  }

  return {
    reconciled: true,
    startedAt: new Date(startedAt).toISOString(),
    dealType,
    deactivated,
  };
}
