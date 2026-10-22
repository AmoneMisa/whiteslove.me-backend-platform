import { enrichListingDetails } from '../listing/listing-enrichment.js';

/**
 * Plans the room-rental reclassification for one batch of long-rent listings
 * (`{ id, source, country, property_type, price, currency, title, description }`).
 * A row is returned when the current parser reads it as a room / bed / shared
 * stay, either from its text or because its price is below what a whole flat on
 * a long lease costs. The reason says which, so a wrong text rule can be told
 * apart from the price floor.
 */
export function planRoomOnlyBackfill(rows) {
  const changes = [];
  for (const row of rows ?? []) {
    const listing = {
      country: row.country,
      dealType: 'longRent',
      propertyType: row.property_type ?? null,
      // The audience stored with the card (it may come from structured parsing the text rules miss).
      audience: row.audience ?? undefined,
      price: row.price == null ? null : Number(row.price),
      currency: row.currency,
      title: row.title ?? '',
      description: row.description ?? '',
    };
    if (enrichListingDetails(listing).roomOnly !== true) continue;
    // Which rule fired: strong wording alone, the bare price floor, or an audience / weak phrase that
    // only counts together with a low price. A wrong rule can then be told apart in the report.
    const byText = enrichListingDetails({ ...listing, price: null }).roomOnly === true;
    const byFloor = enrichListingDetails({ ...listing, title: '', description: '', audience: null }).roomOnly === true;
    let reason = 'audience-or-weak-phrase-with-low-price';
    if (byText) reason = 'room-share-text';
    else if (byFloor) reason = 'price-below-flat-rent-floor';
    changes.push({
      id: String(row.id),
      source: row.source ?? null,
      price: listing.price,
      currency: listing.currency ?? null,
      reason,
      title: String(row.title ?? '').replace(/\s+/gu, ' ').slice(0, 70),
    });
  }
  return changes;
}

/**
 * One batch: read the next page of active long-rent listings that are not yet
 * marked roomOnly (keyset by id) and, in apply mode, set data.roomOnly. The
 * listings_canonicalize_room_rent trigger then moves deal_type to roomRent and
 * the feed sync trigger drops the row from the long-rent feed. The previous deal
 * type stays in data.roomOnlyRepair so the change can be reversed.
 */
export async function runRoomOnlyBackfillBatch(client, { afterId = 0, batchSize = 500, country = null, apply = false } = {}) {
  const rows = await client.query(
    `
      SELECT id, source, country, property_type, price, currency, title, description,
             NULLIF(data->>'audience', '') AS audience
      FROM listings
      WHERE id > $1::bigint
        AND active = TRUE
        AND deal_type = 'longRent'
        AND NOT room_only
        AND ($3::text IS NULL OR country = $3)
      ORDER BY id
      LIMIT $2
    `,
    [String(afterId), batchSize, country],
  );
  const changes = planRoomOnlyBackfill(rows.rows);
  let updated = 0;
  if (apply && changes.length) {
    const result = await client.query(
      `
        UPDATE listings AS l
        SET data = l.data || jsonb_build_object(
              'roomOnly', TRUE,
              'roomOnlyRepair', jsonb_build_object('from', l.deal_type, 'reason', input.reason, 'at', NOW())
            ),
            updated_at = NOW()
        FROM unnest($1::bigint[], $2::text[]) AS input(id, reason)
        WHERE l.id = input.id
          -- Skip rows changed since they were read.
          AND l.deal_type = 'longRent'
          AND NOT l.room_only
      `,
      [changes.map((change) => change.id), changes.map((change) => change.reason)],
    );
    updated = result.rowCount ?? 0;
  }
  const last = rows.rows.at(-1);
  return { scanned: rows.rows.length, changes, updated, nextAfterId: last ? String(last.id) : null };
}
