import { resolveHousingIntent } from '@whiteslove/parsing-lexicon/housing-intent';

/**
 * Plans the wanted-ad reclassification for one batch of listings rows
 * (`{ id, title, description, listing_kind }`). Only rows that the current
 * lexicon reads as propertyWanted but are stored as something else are
 * returned, so an already-correct database produces no writes. The text is the
 * same title + description the normalizer feeds the lexicon at ingestion.
 */
export function planIntentBackfill(rows) {
  const changes = [];
  for (const row of rows ?? []) {
    if (row?.listing_kind === 'propertyWanted') continue;
    const text = `${row?.title ?? ''}\n${row?.description ?? ''}`;
    if (resolveHousingIntent(text)?.listingKind !== 'propertyWanted') continue;
    changes.push({
      id: String(row.id),
      source: row.source ?? null,
      from: row.listing_kind ?? null,
      title: String(row.title ?? '').replace(/\s+/gu, ' ').slice(0, 70),
    });
  }
  return changes;
}

/**
 * One batch: read the next page of active listings by id (keyset) and, in apply
 * mode, flip the stored kind to propertyWanted in one statement. listing_kind is
 * a generated column of data->>'listingKind', so updating `data` fires the feed
 * sync trigger that drops wanted ads from the public feed. The previous value
 * stays in data.listingKindRepair so the change can be reversed.
 */
export async function runIntentBackfillBatch(client, { afterId = 0, batchSize = 500, country = null, includeInactive = false, apply = false } = {}) {
  const rows = await client.query(
    `
      SELECT id, source, title, description, listing_kind
      FROM listings
      WHERE id > $1::bigint
        AND listing_kind <> 'propertyWanted'
        AND ($3::text IS NULL OR country = $3)
        AND ($4::boolean OR active = TRUE)
      ORDER BY id
      LIMIT $2
    `,
    [String(afterId), batchSize, country, includeInactive],
  );
  const changes = planIntentBackfill(rows.rows);
  let updated = 0;
  if (apply && changes.length) {
    const result = await client.query(
      `
        UPDATE listings AS l
        SET data = l.data || jsonb_build_object(
              'listingKind', 'propertyWanted',
              'listingKindRepair', jsonb_build_object('from', l.listing_kind, 'at', NOW())
            ),
            updated_at = NOW()
        WHERE l.id = ANY($1::bigint[])
          -- Skip rows changed since they were read.
          AND l.listing_kind <> 'propertyWanted'
      `,
      [changes.map((change) => change.id)],
    );
    updated = result.rowCount ?? 0;
  }
  const last = rows.rows.at(-1);
  return { scanned: rows.rows.length, changes, updated, nextAfterId: last ? String(last.id) : null };
}
