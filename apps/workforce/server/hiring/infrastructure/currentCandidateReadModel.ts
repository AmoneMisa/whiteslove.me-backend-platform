import type { Pool, PoolClient } from 'pg'

export async function rebuildCurrentCandidates(
  client: Pool | PoolClient,
  schema: string,
): Promise<number> {
  const result = await client.query(`
    WITH desired AS (
      SELECT DISTINCT ON (dedupe_key) dedupe_key, id AS candidate_id
      FROM ${schema}.candidates
      WHERE active = TRUE AND dedupe_key IS NOT NULL AND dedupe_key <> ''
      ORDER BY dedupe_key, created_at DESC, id DESC
    ), removed AS (
      DELETE FROM ${schema}.candidate_current current
      WHERE NOT EXISTS (
        SELECT 1 FROM desired WHERE desired.dedupe_key = current.dedupe_key
      )
    )
    INSERT INTO ${schema}.candidate_current (dedupe_key, candidate_id, updated_at)
    SELECT dedupe_key, candidate_id, NOW() FROM desired
    ON CONFLICT (dedupe_key) DO UPDATE SET
      candidate_id = EXCLUDED.candidate_id,
      updated_at = NOW()
  `)
  return result.rowCount || 0
}

export async function syncCurrentCandidateKeys(
  client: Pool | PoolClient,
  schema: string,
  keys: string[],
): Promise<void> {
  const uniqueKeys = [...new Set(keys.map((value) => String(value || '').trim()).filter(Boolean))]
  if (!uniqueKeys.length) return

  await client.query(
    `DELETE FROM ${schema}.candidate_current current
     WHERE current.dedupe_key = ANY($1::text[])`,
    [uniqueKeys],
  )
  await client.query(
    `INSERT INTO ${schema}.candidate_current (dedupe_key, candidate_id, updated_at)
     SELECT DISTINCT ON (dedupe_key) dedupe_key, id, NOW()
     FROM ${schema}.candidates
     WHERE active = TRUE
       AND dedupe_key = ANY($1::text[])
     ORDER BY dedupe_key, created_at DESC, id DESC
     ON CONFLICT (dedupe_key) DO UPDATE SET
       candidate_id = EXCLUDED.candidate_id,
       updated_at = NOW()`,
    [uniqueKeys],
  )
}
