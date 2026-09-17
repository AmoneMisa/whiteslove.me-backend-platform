/**
 * Retention for candidate (CV) profiles
 * (whiteslove.me-backend-platform docs/privacy/RETENTION_POLICY_DRAFT.md).
 *
 * A profile is kept while it is still published at its source -- every crawl
 * that sees it again refreshes last_seen_at -- and deleted six months after it
 * was last seen. Identity keys and the current-candidate read model cascade
 * from the candidate row.
 *
 * Nothing is deleted unless PRIVACY_RETENTION_POLICY_APPROVED names this exact
 * policy version, the same gate as the flats retention executor.
 */

/** Must equal RETENTION_POLICY_VERSION in apps/flats/src/privacy/retention-policy.js
 * (a test keeps them in step). */
export const RETENTION_POLICY_VERSION = '2026-09-draft-1'

export const CANDIDATE_RETENTION_DAYS = 180

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }>
}

export function retentionApproved(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.PRIVACY_RETENTION_POLICY_APPROVED ?? '').trim() === RETENTION_POLICY_VERSION
}

export type CandidateRetentionReport = {
  approved: boolean
  deleted: number
  batches: number
  exhausted: boolean
}

/**
 * Deletes candidates not seen at their source for the retention period, in
 * bounded batches by id so a first run over a large backlog never holds one
 * long lock. The range uses the last_seen_at index from migration 003.
 */
export async function purgeStaleCandidates(
  client: Queryable,
  schema: string,
  { env = process.env, batchSize = 1000, maxBatches = 20 }: { env?: Record<string, string | undefined>; batchSize?: number; maxBatches?: number } = {},
): Promise<CandidateRetentionReport> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('invalid schema')
  if (!retentionApproved(env)) return { approved: false, deleted: 0, batches: 0, exhausted: false }

  const size = Math.min(10_000, Math.max(1, Math.floor(Number(batchSize) || 1000)))
  let deleted = 0
  let batches = 0
  while (batches < maxBatches) {
    const result = await client.query(
      `
        DELETE FROM ${schema}.candidates
        WHERE id IN (
          SELECT id FROM ${schema}.candidates
          WHERE last_seen_at < NOW() - make_interval(days => $1::int)
          ORDER BY last_seen_at
          LIMIT $2
        )
      `,
      [CANDIDATE_RETENTION_DAYS, size],
    )
    batches += 1
    const count = result.rowCount ?? 0
    deleted += count
    if (count < size) break
  }
  return { approved: true, deleted, batches, exhausted: batches >= maxBatches }
}
