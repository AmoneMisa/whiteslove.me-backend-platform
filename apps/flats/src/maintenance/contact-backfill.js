import { canonicalListingContact } from '../listing/contact-canonical.js';

/**
 * Plans the stored-contact rewrite for one batch of listings rows
 * (`{ id, country, contact }`). Only rows whose canonical form differs are
 * returned, so an already-normalised database produces no writes.
 */
export function planContactBackfill(rows) {
  const changes = [];
  for (const row of rows ?? []) {
    if (typeof row?.contact !== 'string') continue;
    const canonical = canonicalListingContact(row.contact, row.country);
    if (typeof canonical !== 'string' || canonical === row.contact) continue;
    changes.push({ id: String(row.id), from: row.contact, to: canonical });
  }
  return changes;
}

/**
 * One batch: read the next page of listings with a string contact by id
 * (keyset), and in apply mode rewrite the changed contacts in one statement.
 * Updating `data` recomputes the stored dedupe key and fires the existing feed
 * and property-cluster sync triggers, which is why batches stay small.
 */
export async function runContactBackfillBatch(client, { afterId = 0, batchSize = 500, country = null, includeInactive = false, apply = false } = {}) {
  const rows = await client.query(
    `
      SELECT id, country, data->>'contact' AS contact
      FROM listings
      WHERE id > $1::bigint
        AND jsonb_typeof(data->'contact') = 'string'
        AND ($3::text IS NULL OR country = $3)
        AND ($4::boolean OR active = TRUE)
      ORDER BY id
      LIMIT $2
    `,
    [String(afterId), batchSize, country, includeInactive],
  );
  const changes = planContactBackfill(rows.rows);
  let updated = 0;
  if (apply && changes.length) {
    const result = await client.query(
      `
        UPDATE listings AS l
        SET data = jsonb_set(l.data, '{contact}', to_jsonb(input.contact))
        FROM unnest($1::bigint[], $2::text[]) AS input(id, contact)
        WHERE l.id = input.id
          -- Skip rows changed since they were read.
          AND l.data->>'contact' IS DISTINCT FROM input.contact
      `,
      [changes.map((change) => change.id), changes.map((change) => change.to)],
    );
    updated = result.rowCount ?? 0;
  }
  const last = rows.rows.at(-1);
  return {
    scanned: rows.rows.length,
    changes,
    updated,
    nextAfterId: last ? String(last.id) : null,
  };
}
