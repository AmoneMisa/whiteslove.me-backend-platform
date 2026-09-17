import { pool } from './pool.js';
import { resolveListingLine } from '../../identity/listing-line.js';

/**
 * Listing lines: computed by the worker, stored in platform.listing_lines,
 * read by the feed and by the "Trusted ads" / "Hide danger" filters.
 *
 * Contacts are matched on the stored `listings.data->>'contact'` string, which
 * migration 056 indexes for active listings. Telegram handles are stored with
 * their original case, so those are matched case-insensitively.
 */

/** Stored lines for a page of listings: one primary-key lookup. */
export async function loadStoredListingLines(listingIds, client = pool) {
  const ids = [...new Set((listingIds ?? []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const lines = new Map();
  if (!ids.length) return lines;
  const result = await client.query(
    'SELECT listing_id, line, other_properties FROM platform.listing_lines WHERE listing_id = ANY($1::bigint[])',
    [ids],
  );
  for (const row of result.rows) {
    lines.set(Number(row.listing_id), { line: row.line, otherProperties: Number(row.other_properties) || 0 });
  }
  return lines;
}

/** The stored contact string a contact point appears as in listings. */
function storedContactKey(type, value) {
  if (type === 'telegram') return `@${String(value).toLowerCase()}`;
  return String(value);
}

/**
 * Recomputes every line and replaces the table contents in one statement.
 *
 * Query 1: contacts advertising more than one distinct property (index-only
 * over migration 056's partial index). Query 2: evidence per contact through
 * contact point -> actor -> evidence, with restriction flags and open
 * disputes. Lines are resolved in application code, expanded to listing ids by
 * query 3 through the contact index, and written by query 4, which upserts
 * changed rows, skips unchanged ones and deletes rows that lost their line.
 */
export async function refreshListingLines({ client = pool, now = new Date(), resolveLine = resolveListingLine } = {}) {
  const startedAt = Date.now();

  const [multi, evidence] = await Promise.all([
    client.query(`
      SELECT data->>'contact' AS contact, count(DISTINCT dedupe_key)::int AS properties
      FROM listings
      WHERE active = TRUE AND data->>'contact' IS NOT NULL
      GROUP BY data->>'contact'
      HAVING count(DISTINCT dedupe_key) > 1
    `),
    client.query(`
      SELECT c.type, c.canonical_value,
             (a.processing_restricted_at IS NOT NULL OR a.processing_objection_at IS NOT NULL
               OR c.processing_restricted_at IS NOT NULL) AS restricted,
             e.id, e.polarity, e.reason_code, e.dimension, e.independent_count, e.review_state, e.last_observed_at,
             EXISTS (
               SELECT 1 FROM platform.dispute_cases d
               WHERE d.status IN ('open', 'in_review')
                 AND (d.evidence_id = e.id OR (d.actor_id = a.id AND d.dispute_type <> 'incorrect_risk_evidence'))
             ) AS under_dispute
      FROM platform.actor_evidence e
      JOIN platform.actor_identities a ON a.id = e.actor_id
      JOIN platform.actor_contact_points l ON l.actor_id = a.id
      JOIN platform.contact_points c ON c.id = l.contact_point_id
      WHERE c.type IN ('phone', 'telegram')
    `),
  ]);

  // Contact key -> inputs. Keys are lower-cased for Telegram so evidence and
  // listing contacts meet regardless of how the handle was capitalised.
  const inputs = new Map();
  const entry = (key) => {
    let value = inputs.get(key);
    if (!value) {
      value = { otherProperties: 0, restricted: false, evidence: [] };
      inputs.set(key, value);
    }
    return value;
  };
  for (const row of multi.rows) {
    const key = row.contact.startsWith('@') ? row.contact.toLowerCase() : row.contact;
    const value = entry(key);
    value.otherProperties = Math.max(value.otherProperties, Number(row.properties) - 1);
  }
  for (const row of evidence.rows) {
    const value = entry(storedContactKey(row.type, row.canonical_value));
    value.restricted ||= row.restricted === true;
    value.evidence.push({
      id: Number(row.id),
      polarity: row.polarity,
      reasonCode: row.reason_code,
      dimension: row.dimension,
      independentCount: Number(row.independent_count),
      reviewState: row.review_state,
      lastObservedAt: row.last_observed_at,
      underDispute: row.under_dispute === true,
    });
  }

  const lineByContact = new Map();
  for (const [key, input] of inputs) {
    const { line } = resolveLine({ ...input, now });
    if (line) lineByContact.set(key, { line, otherProperties: input.otherProperties });
  }

  let ids = [];
  let lines = [];
  let others = [];
  if (lineByContact.size) {
    const exact = [...lineByContact.keys()].filter((key) => !key.startsWith('@'));
    const handles = [...lineByContact.keys()].filter((key) => key.startsWith('@'));
    const listings = await client.query(
      `
        SELECT id, data->>'contact' AS contact
        FROM listings
        WHERE active = TRUE
          AND data->>'contact' IS NOT NULL
          AND (data->>'contact' = ANY($1::text[]) OR lower(data->>'contact') = ANY($2::text[]))
      `,
      [exact, handles],
    );
    for (const row of listings.rows) {
      const key = row.contact.startsWith('@') ? row.contact.toLowerCase() : row.contact;
      const resolved = lineByContact.get(key);
      if (!resolved) continue;
      ids.push(Number(row.id));
      lines.push(resolved.line);
      others.push(resolved.otherProperties);
    }
  }

  const written = await client.query(
    `
      WITH input AS (
        SELECT * FROM unnest($1::bigint[], $2::varchar[], $3::int[]) AS t(listing_id, line, other_properties)
      ),
      upserted AS (
        INSERT INTO platform.listing_lines (listing_id, line, other_properties, computed_at)
        SELECT listing_id, line, other_properties, NOW() FROM input
        ON CONFLICT (listing_id) DO UPDATE
          SET line = EXCLUDED.line, other_properties = EXCLUDED.other_properties, computed_at = EXCLUDED.computed_at
          -- Unchanged rows are not rewritten, so a quiet cycle writes nothing.
          WHERE platform.listing_lines.line IS DISTINCT FROM EXCLUDED.line
             OR platform.listing_lines.other_properties IS DISTINCT FROM EXCLUDED.other_properties
        RETURNING 1
      ),
      removed AS (
        DELETE FROM platform.listing_lines ll
        WHERE NOT EXISTS (SELECT 1 FROM input i WHERE i.listing_id = ll.listing_id)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM upserted)::int AS upserted, (SELECT count(*) FROM removed)::int AS removed
    `,
    [ids, lines, others],
  );

  return {
    listings: ids.length,
    contacts: lineByContact.size,
    upserted: written.rows[0]?.upserted ?? 0,
    removed: written.rows[0]?.removed ?? 0,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * The same contact's other listings, one per distinct property, newest first.
 * Served by migration 056's contact index; the source listing must be active.
 */
export async function findContactListings(publicId, { limit = 30 } = {}, client = pool) {
  const id = Number(publicId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const size = Math.min(50, Math.max(1, Math.floor(Number(limit) || 30)));
  const result = await client.query(
    `
      WITH src AS (
        SELECT data->>'contact' AS contact, dedupe_key
        FROM listings
        WHERE id = $1 AND active = TRUE AND data->>'contact' IS NOT NULL
      ),
      per_property AS (
        SELECT DISTINCT ON (l.dedupe_key) l.id, l.source, l.country, l.source_id, l.data, l.created_at
        FROM src
        JOIN listings l
          ON l.active = TRUE
         AND l.data->>'contact' = src.contact
         AND l.dedupe_key <> src.dedupe_key
        ORDER BY l.dedupe_key, l.created_at DESC NULLS LAST, l.id DESC
      )
      SELECT id, source, country, source_id, data
      FROM per_property
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT $2
    `,
    [id, size],
  );
  return result.rows.map((row) => ({
    ...(row.data || {}),
    id: String(row.source_id || row.data?.id || ''),
    source: row.source,
    country: row.country,
    publicId: Number(row.id),
  }));
}
