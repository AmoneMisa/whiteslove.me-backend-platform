import { pool } from './pool.js';

/**
 * Registry signals: which active listings advertise a contact that the imported legacy registry classes as risk or
 * trusted. Computed by the worker in one statement, read by the feed next to the listing line.
 *
 * Phones are stored in listings as E.164 and Telegram handles as "@handle" (any case), the same keys the listing
 * contact index (migration 056) serves. An ambiguous contact (claimed by clusters of both kinds) and a contact whose
 * subject restricted or objected to processing produce no signal.
 */
export async function refreshListingRegistrySignals({ client = pool } = {}) {
  const startedAt = Date.now();
  const result = await client.query(`
    WITH reg AS (
      SELECT ri.identifier_type AS type,
             CASE ri.identifier_type WHEN 'telegram' THEN '@' || lower(ri.canonical_value) ELSE ri.canonical_value END AS key,
             ri.canonical_value,
             bool_or(c.kind IN ('risk', 'both')) AS risk,
             bool_or(c.kind IN ('trusted', 'both')) AS trusted
      FROM platform.registry_identifiers ri
      JOIN platform.registry_clusters c USING (cluster_id)
      WHERE ri.identifier_type IN ('phone', 'telegram') AND ri.normalization_error IS NULL
      GROUP BY 1, 2, 3
      HAVING bool_or(c.kind IN ('risk', 'both')) <> bool_or(c.kind IN ('trusted', 'both'))
    ),
    input AS (
      SELECT m.listing_id, CASE WHEN r.risk THEN 'risk' ELSE 'trusted' END AS signal, r.type, r.canonical_value
      FROM reg r
      JOIN (
        -- Two plain equality joins (the contact index serves the first); one OR would force a nested loop.
        SELECT l.id AS listing_id, l.data->>'contact' AS key FROM listings l WHERE l.active = TRUE AND l.data->>'contact' IS NOT NULL
        UNION
        SELECT l.id, lower(l.data->>'contact') FROM listings l WHERE l.active = TRUE AND l.data->>'contact' LIKE '@%'
      ) m ON m.key = r.key
      WHERE NOT EXISTS (
        SELECT 1 FROM platform.contact_points cp
        LEFT JOIN platform.actor_contact_points acp ON acp.contact_point_id = cp.id
        LEFT JOIN platform.actor_identities a ON a.id = acp.actor_id
        WHERE cp.type = r.type AND cp.canonical_value = r.canonical_value
          AND (cp.processing_restricted_at IS NOT NULL OR a.processing_restricted_at IS NOT NULL OR a.processing_objection_at IS NOT NULL)
      )
    ),
    upserted AS (
      INSERT INTO platform.listing_registry_signals (listing_id, signal, computed_at)
      SELECT listing_id, min(signal), NOW() FROM input GROUP BY listing_id HAVING count(DISTINCT signal) = 1
      ON CONFLICT (listing_id) DO UPDATE SET signal = EXCLUDED.signal, computed_at = EXCLUDED.computed_at
        WHERE platform.listing_registry_signals.signal IS DISTINCT FROM EXCLUDED.signal
      RETURNING 1
    ),
    removed AS (
      DELETE FROM platform.listing_registry_signals s
      WHERE NOT EXISTS (SELECT 1 FROM input i WHERE i.listing_id = s.listing_id)
         OR s.listing_id IN (SELECT listing_id FROM input GROUP BY listing_id HAVING count(DISTINCT signal) > 1)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM upserted)::int AS upserted, (SELECT count(*) FROM removed)::int AS removed
  `);
  return { ...(result.rows[0] ?? { upserted: 0, removed: 0 }), durationMs: Date.now() - startedAt };
}

/** Signals for a page of listings: listing id -> 'risk' | 'trusted'. One primary-key lookup. */
export async function loadRegistrySignals(listingIds, client = pool) {
  const ids = [...new Set((listingIds ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const signals = new Map();
  if (!ids.length) return signals;
  const result = await client.query('SELECT listing_id, signal FROM platform.listing_registry_signals WHERE listing_id = ANY($1::bigint[])', [ids]);
  for (const row of result.rows) signals.set(Number(row.listing_id), row.signal);
  return signals;
}
