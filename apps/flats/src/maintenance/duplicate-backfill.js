/**
 * Active custom listings that are the same card seen again: same detail URL and
 * the same text. Before listing ids became stable (owner-html/custom.js keyed
 * them on the catalogue page and position), every crawl inserted the card as a
 * new row, so one prod listing was stored up to a dozen times.
 *
 * Cards without their own URL share the catalogue page URL, so the URL alone is
 * not an identity: the text prefix has to match too. The newest row (by
 * last_seen_at, then id) is kept; the others are deactivated, like an expired
 * listing, and removed from the search index.
 */
export async function runDuplicateBackfillBatch(client, { batchSize = 2000, country = null, apply = false, removeFromIndex } = {}) {
  const found = await client.query(
    `
      WITH ranked AS (
        SELECT id, source, country, source_id, data->>'url' AS url,
               LEFT(REGEXP_REPLACE(COALESCE(title, ''), '\\s+', ' ', 'g'), 80) AS title,
               ROW_NUMBER() OVER (
                 PARTITION BY data->>'url', MD5(LEFT(COALESCE(description, ''), 240))
                 ORDER BY last_seen_at DESC NULLS LAST, id DESC
               ) AS rn
        FROM listings
        WHERE active = TRUE
          AND source = 'custom'
          AND COALESCE(data->>'url', '') <> ''
          AND ($2::text IS NULL OR country = $2)
      )
      SELECT id, source, country, source_id, url, title
      FROM ranked
      WHERE rn > 1
      ORDER BY id
      LIMIT $1
    `,
    [batchSize, country],
  );
  const duplicates = found.rows.map((row) => ({
    id: String(row.id), source: row.source, country: row.country, sourceId: String(row.source_id), url: row.url, title: row.title,
  }));
  let deactivated = 0;
  if (apply && duplicates.length) {
    const result = await client.query(
      `
        UPDATE listings
        SET active = FALSE,
            inactive_at = COALESCE(inactive_at, NOW()),
            availability_status = 'inactive',
            availability_reason = 'duplicate_of_newer_row',
            updated_at = NOW()
        WHERE id = ANY($1::bigint[])
          AND active = TRUE
        RETURNING source, country, source_id
      `,
      [duplicates.map((row) => row.id)],
    );
    deactivated = result.rowCount ?? 0;
    if (removeFromIndex && result.rows.length) {
      await removeFromIndex(result.rows.map((row) => ({ source: row.source, country: row.country, id: String(row.source_id) })));
    }
  }
  return { found: duplicates.length, duplicates, deactivated };
}
