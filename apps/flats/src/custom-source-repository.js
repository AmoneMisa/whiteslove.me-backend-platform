import {pool} from './db.js';

export async function deactivateMissingCustomSourceListings({
  country,
  sourceUrl,
  crawlStartedAt,
}) {
  const result = await pool.query(
    `
      UPDATE listings
      SET
        active = FALSE,
        updated_at = NOW()
      WHERE source = 'custom'
        AND country = $1
        AND data->>'customSourceUrl' = $2
        AND active = TRUE
        AND last_seen_at < $3::timestamptz
      RETURNING source_id
    `,
    [String(country).toUpperCase(), String(sourceUrl), crawlStartedAt],
  );
  return result.rowCount;
}
