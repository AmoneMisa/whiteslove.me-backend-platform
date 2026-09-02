import {pool} from '../infrastructure/database/pool.js';
import {deleteListingDocuments} from '../infrastructure/search/elasticsearch.js';

const LISTING_MAX_AGE_DAYS = 14;
const DEFAULT_BATCH = 5000;

export async function deactivateExpiredListings(limit = DEFAULT_BATCH) {
  const batch = Math.max(1, Math.min(20_000, Math.trunc(Number(limit) || DEFAULT_BATCH)));
  const result = await pool.query(`
    WITH expired AS (
      SELECT id
      FROM listings
      WHERE active = TRUE
        AND COALESCE(created_at, first_seen_at) < NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY COALESCE(created_at, first_seen_at) ASC, id ASC
      LIMIT $2
    )
    UPDATE listings l
    SET
      active = FALSE,
      inactive_at = COALESCE(l.inactive_at, NOW()),
      updated_at = NOW()
    FROM expired e
    WHERE l.id = e.id
      AND l.active = TRUE
    RETURNING l.source, l.country, l.source_id
  `, [LISTING_MAX_AGE_DAYS, batch]);

  const deactivated = result.rows.map((row) => ({
    source: row.source,
    country: row.country,
    id: String(row.source_id),
  }));

  if (deactivated.length) {
    try {
      await deleteListingDocuments(deactivated);
    } catch (error) {
      console.warn('[listing-lifecycle] Elasticsearch cleanup failed:', error?.message ?? error);
    }
  }

  return {
    deactivated: deactivated.length,
    saturated: deactivated.length === batch,
  };
}
