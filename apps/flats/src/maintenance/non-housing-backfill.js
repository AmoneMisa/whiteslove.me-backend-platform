import { hasHousingSignal } from '../scrapers/social.js';

// Social posts ("продам ноутбук", "iPhone ... аренда с выкупом") that were stored
// as listings before the crawler required a housing word, rooms or an area.
// Telegram has its own filter (scrapers/telegram.js) and many real posts use abbreviations
// ("2шку", "1 кВ"), so only the crawlers that share social.js are cleaned here.
const SOCIAL_SOURCES = ['threads', 'facebook'];

/** Active social rows whose title+description carry no housing signal at all. */
export function planNonHousingBackfill(rows) {
  const changes = [];
  for (const row of rows ?? []) {
    const text = `${row?.title ?? ''}\n${row?.description ?? ''}`.replace(/[ \t]+/g, ' ').trim();
    if (hasHousingSignal(text)) continue;
    changes.push({ id: String(row.id), source: row.source ?? null, title: String(row.title ?? '').replace(/\s+/gu, ' ').slice(0, 70) });
  }
  return changes;
}

/**
 * One batch (keyset by id): deactivate the rows planned above and, like an
 * expired listing, remove them from the search index. Nothing is deleted.
 */
export async function runNonHousingBackfillBatch(client, { afterId = 0, batchSize = 1000, apply = false, removeFromIndex } = {}) {
  const rows = await client.query(
    `
      SELECT id, source, country, source_id, title, description
      FROM listings
      WHERE id > $1::bigint
        AND active = TRUE
        AND source = ANY($3::text[])
      ORDER BY id
      LIMIT $2
    `,
    [String(afterId), batchSize, SOCIAL_SOURCES],
  );
  const changes = planNonHousingBackfill(rows.rows);
  let deactivated = 0;
  if (apply && changes.length) {
    const result = await client.query(
      `
        UPDATE listings
        SET active = FALSE,
            inactive_at = COALESCE(inactive_at, NOW()),
            availability_status = 'inactive',
            availability_reason = 'not_a_housing_post',
            updated_at = NOW()
        WHERE id = ANY($1::bigint[])
          AND active = TRUE
        RETURNING source, country, source_id
      `,
      [changes.map((change) => change.id)],
    );
    deactivated = result.rowCount ?? 0;
    if (removeFromIndex && result.rows.length) {
      await removeFromIndex(result.rows.map((row) => ({ source: row.source, country: row.country, id: String(row.source_id) })));
    }
  }
  const last = rows.rows.at(-1);
  return { scanned: rows.rows.length, changes, deactivated, nextAfterId: last ? String(last.id) : null };
}
