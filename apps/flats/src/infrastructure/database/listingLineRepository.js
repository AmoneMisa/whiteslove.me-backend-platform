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
  const restrictedContacts = [];
  for (const [key, input] of inputs) {
    if (input.restricted) restrictedContacts.push(key);
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
    // For the owners refresh, which must skip these contacts too.
    restrictedContacts,
    durationMs: Date.now() - startedAt,
  };
}

/** Stored contacts owner collections are built from: normalised phones and
 * Telegram handles only, never free text that happens to repeat. */
const OWNER_CONTACT_PATTERN = '^(\\+[1-9][0-9]{6,14}|@[a-z0-9_]{5,32})$';

/**
 * Rebuilds platform.listing_owners: contacts with two or more distinct active
 * properties, in one statement. Runs after refreshListingLines so each owner's
 * line comes from the fresh listing lines, and skips contacts whose subject
 * restricted or objected to processing.
 *
 * The aggregate scans the migration 056 contact index; country, city and the
 * newest listing are then read only for owners that qualified.
 */
export async function refreshListingOwners({ client = pool, restrictedContacts = [] } = {}) {
  const startedAt = Date.now();
  const result = await client.query(
    `
      WITH multi AS (
        SELECT data->>'contact' AS contact,
               count(DISTINCT dedupe_key)::int AS properties,
               count(*)::int AS listings
        FROM listings
        WHERE active = TRUE
          AND data->>'contact' IS NOT NULL
          AND data->>'contact' ~ $2
        GROUP BY data->>'contact'
        HAVING count(DISTINCT dedupe_key) >= 2
      ),
      input AS (
        SELECT left(encode(sha256(convert_to(m.contact, 'UTF8')), 'hex'), 24) AS owner_key,
               m.contact, m.properties, m.listings,
               stats.country, stats.city, stats.sample_listing_id,
               ll.line
        FROM multi m
        CROSS JOIN LATERAL (
          SELECT mode() WITHIN GROUP (ORDER BY l.country) AS country,
                 mode() WITHIN GROUP (ORDER BY l.city) FILTER (WHERE l.city IS NOT NULL) AS city,
                 max(l.id) AS sample_listing_id
          FROM listings l
          WHERE l.active = TRUE AND l.data->>'contact' = m.contact
        ) stats
        LEFT JOIN platform.listing_lines ll ON ll.listing_id = stats.sample_listing_id
        WHERE NOT (m.contact = ANY($1::text[]))
      ),
      upserted AS (
        INSERT INTO platform.listing_owners
          (owner_key, contact, country, city, properties, listings, line, sample_listing_id, computed_at)
        SELECT owner_key, contact, country, city, properties, listings, line, sample_listing_id, NOW() FROM input
        ON CONFLICT (owner_key) DO UPDATE
          SET country = EXCLUDED.country, city = EXCLUDED.city, properties = EXCLUDED.properties,
              listings = EXCLUDED.listings, line = EXCLUDED.line,
              sample_listing_id = EXCLUDED.sample_listing_id, computed_at = EXCLUDED.computed_at
          -- Unchanged owners are not rewritten.
          WHERE (platform.listing_owners.country, platform.listing_owners.city, platform.listing_owners.properties,
                 platform.listing_owners.listings, platform.listing_owners.line, platform.listing_owners.sample_listing_id)
            IS DISTINCT FROM
                (EXCLUDED.country, EXCLUDED.city, EXCLUDED.properties,
                 EXCLUDED.listings, EXCLUDED.line, EXCLUDED.sample_listing_id)
        RETURNING 1
      ),
      removed AS (
        DELETE FROM platform.listing_owners o
        WHERE NOT EXISTS (SELECT 1 FROM input i WHERE i.owner_key = o.owner_key)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM input)::int AS owners,
             (SELECT count(*) FROM upserted)::int AS upserted,
             (SELECT count(*) FROM removed)::int AS removed
    `,
    [restrictedContacts, OWNER_CONTACT_PATTERN],
  );
  const row = result.rows[0] ?? {};
  return { owners: row.owners ?? 0, upserted: row.upserted ?? 0, removed: row.removed ?? 0, durationMs: Date.now() - startedAt };
}

const OWNER_KEY_RE = /^[0-9a-f]{24}$/u;

/** Whether a value is a well-formed owner key, checked before it reaches SQL. */
export const isOwnerKey = (value) => typeof value === 'string' && OWNER_KEY_RE.test(value);

/** Parses an owners-page cursor ("<properties>:<ownerKey>"). */
export function parseOwnerCursor(value) {
  const match = /^(\d{1,9}):([0-9a-f]{24})$/u.exec(String(value ?? ''));
  return match ? { properties: Number(match[1]), ownerKey: match[2] } : null;
}

/**
 * One page of owners for a country, largest first. Keyset on
 * (properties DESC, owner_key), served by listing_owners_country_page_idx; one
 * extra row is read instead of counting.
 */
export async function listOwners({ country, limit = 24, after = null } = {}, client = pool) {
  const code = typeof country === 'string' && /^[A-Z]{2}$/u.test(country) ? country : null;
  if (!code) return { owners: [], next: null };
  const size = Math.min(60, Math.max(1, Math.floor(Number(limit) || 24)));
  const params = [code, size + 1];
  let cursor = '';
  if (after && Number.isSafeInteger(after.properties) && isOwnerKey(after.ownerKey)) {
    params.push(after.properties, after.ownerKey);
    cursor = 'AND (o.properties < $3 OR (o.properties = $3 AND o.owner_key > $4))';
  }
  const result = await client.query(
    `
      SELECT o.owner_key, o.contact, o.country, o.city, o.properties, o.listings, o.line,
             l.id AS sample_public_id, l.data->>'title' AS sample_title,
             COALESCE(NULLIF(l.data->>'photo', ''), l.data->'photos'->>0) AS sample_photo
      FROM platform.listing_owners o
      LEFT JOIN listings l ON l.id = o.sample_listing_id
      WHERE o.country = $1 ${cursor}
      ORDER BY o.properties DESC, o.owner_key
      LIMIT $2
    `,
    params,
  );
  const owners = result.rows.slice(0, size).map(mapOwner);
  const last = owners.at(-1);
  return {
    owners,
    next: result.rows.length > size && last ? `${last.properties}:${last.ownerKey}` : null,
  };
}

/** One owner, for the breadcrumb of an owner's collection. */
export async function getOwner(ownerKey, client = pool) {
  if (!isOwnerKey(ownerKey)) return null;
  const result = await client.query(
    `
      SELECT owner_key, contact, country, city, properties, listings, line
      FROM platform.listing_owners
      WHERE owner_key = $1
    `,
    [ownerKey],
  );
  return result.rows[0] ? mapOwner(result.rows[0]) : null;
}

function mapOwner(row) {
  return {
    ownerKey: row.owner_key,
    contact: row.contact,
    country: row.country,
    city: row.city ?? null,
    properties: Number(row.properties),
    listings: Number(row.listings),
    listingLine: row.line ?? null,
    sample: row.sample_public_id
      ? { publicId: Number(row.sample_public_id), title: row.sample_title ?? '', photo: row.sample_photo ?? null }
      : null,
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
