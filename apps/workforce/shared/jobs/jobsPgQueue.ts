import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i
const DEFAULT_MAX_ATTEMPTS = Math.max(1, Number(process.env.JOBS_QUEUE_MAX_ATTEMPTS) || 5)
const DEFAULT_LEASE_MS = Math.max(60_000, Number(process.env.JOBS_QUEUE_LEASE_SECONDS || 240) * 1000)
const RETRY_BASE_MS = Math.max(5_000, Number(process.env.JOBS_QUEUE_RETRY_BASE_MS) || 30_000)
const RETRY_MAX_MS = Math.max(RETRY_BASE_MS, Number(process.env.JOBS_QUEUE_RETRY_MAX_MS) || 5 * 60_000)
const HISTORY_DAYS = Math.max(1, Number(process.env.JOBS_QUEUE_HISTORY_DAYS) || 7)

let pool: Pool | undefined
let schemaReady: Promise<void> | undefined

function schema(): string {
  const raw = String(process.env.JOBS_QUEUE_DB_SCHEMA || 'site_queue').trim()
  return SCHEMA_RE.test(raw) ? raw : 'site_queue'
}

function databaseUrl(): string {
  return String(process.env.JOBS_QUEUE_DATABASE_URL || process.env.HIRING_DATABASE_URL || '').trim()
}

export function jobsQueueDbEnabled(): boolean {
  return databaseUrl().length > 0
}

function db(): Pool {
  const url = databaseUrl()
  if (!url) throw new Error('JOBS_QUEUE_DATABASE_URL or HIRING_DATABASE_URL is required')
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: Math.max(2, Number(process.env.JOBS_QUEUE_DB_POOL_MAX) || 4),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    pool.on('error', (error) => console.error('[jobs:pg-queue] idle client error:', error.message))
  }
  return pool
}

export async function initJobsPgQueue(): Promise<void> {
  if (schemaReady) return schemaReady
  const name = schema()
  schemaReady = (async () => {
    const relations = await db().query(
      'SELECT to_regclass($1)::text AS tasks, to_regclass($2)::text AS scheduler_state',
      [`${name}.tasks`, `${name}.scheduler_state`],
    )
    const row = relations.rows[0]
    if (!row?.tasks || !row?.scheduler_state) {
      throw new Error(`Queue schema ${name} is not migrated; run scripts/migrate-database.ts before runtime`)
    }

    const scheduler = await db().query(`SELECT id FROM ${name}.scheduler_state WHERE id = 1`)
    if (!scheduler.rowCount) {
      throw new Error(`Queue schema ${name} has no scheduler_state row; re-run database migrations`)
    }
  })().catch((error) => {
    schemaReady = undefined
    throw error
  })
  return schemaReady
}

type QueueSeed = {
  type: 'jobs.refresh.source' | 'hiring.refresh.channel'
  target: string
  priority: number
  payload: Record<string, unknown>
}

async function insertSeeds(client: PoolClient, generation: string, seeds: QueueSeed[]): Promise<number> {
  const name = schema()
  let inserted = 0
  for (const seed of seeds) {
    const taskKey = `${generation}:${seed.type}:${seed.target.toLowerCase()}`
    const result = await client.query(
      `INSERT INTO ${name}.tasks (
         task_key, generation, type, target, priority, payload
       )
       SELECT $1, $2, $3, $4, $5, $6::jsonb
       WHERE NOT EXISTS (
         SELECT 1
         FROM ${name}.tasks AS active
         WHERE active.type = $3
           AND LOWER(active.target) = LOWER($4)
           AND active.status IN ('pending', 'running')
       )
       ON CONFLICT (task_key) DO NOTHING
       RETURNING id`,
      [taskKey, generation, seed.type, seed.target, seed.priority, JSON.stringify(seed.payload)],
    )
    inserted += result.rowCount || 0
  }
  return inserted
}

export async function dispatchDueJobsQueue({
  sources,
  hiringHandles,
  backfillHandles,
  jobsRefreshSeconds,
  hiringRefreshSeconds,
  backfillSeconds,
  jobsEnabled,
  hiringEnabled,
}: {
  sources: string[]
  hiringHandles: string[]
  backfillHandles: string[]
  jobsRefreshSeconds: number
  hiringRefreshSeconds: number
  backfillSeconds: number
  jobsEnabled: boolean
  hiringEnabled: boolean
}) {
  await initJobsPgQueue()
  const name = schema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [743_101])
    const stateResult = await client.query(
      `SELECT jobs_due_at, hiring_due_at, backfill_due_at
       FROM ${name}.scheduler_state WHERE id = 1 FOR UPDATE`,
    )
    const state = stateResult.rows[0] || {}
    const now = Date.now()
    const due = (value: unknown) => !value || new Date(String(value)).getTime() <= now
    let jobsQueued = 0
    let hiringQueued = 0
    let backfillQueued = 0

    let nextJobsDue = state.jobs_due_at
    let nextHiringDue = state.hiring_due_at
    let nextBackfillDue = state.backfill_due_at

    if (jobsEnabled && due(state.jobs_due_at)) {
      const generation = `jobs-${randomUUID()}`
      jobsQueued = await insertSeeds(
        client,
        generation,
        [...new Set(sources)].map((source) => ({
          type: 'jobs.refresh.source' as const,
          target: source,
          priority: 10,
          payload: { type: 'jobs.refresh.source', source },
        })),
      )
      nextJobsDue = new Date(now + Math.max(60, jobsRefreshSeconds) * 1000)
    }

    if (hiringEnabled && due(state.hiring_due_at)) {
      const generation = `hiring-${randomUUID()}`
      hiringQueued = await insertSeeds(
        client,
        generation,
        [...new Set(hiringHandles)].map((handle) => ({
          type: 'hiring.refresh.channel' as const,
          target: handle,
          priority: 8,
          payload: { type: 'hiring.refresh.channel', handle },
        })),
      )
      nextHiringDue = new Date(now + Math.max(60, hiringRefreshSeconds) * 1000)
      nextBackfillDue = new Date(now + Math.max(60, backfillSeconds) * 1000)
    } else if (hiringEnabled && due(state.backfill_due_at) && backfillHandles.length) {
      const activeHiring = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM ${name}.tasks
         WHERE type = 'hiring.refresh.channel'
           AND status IN ('pending', 'running')`,
      )
      if (Number(activeHiring.rows[0]?.count || 0) === 0) {
        const generation = `hiring-backfill-${randomUUID()}`
        backfillQueued = await insertSeeds(
          client,
          generation,
          [...new Set(backfillHandles)].map((handle) => ({
            type: 'hiring.refresh.channel' as const,
            target: handle,
            priority: 4,
            payload: { type: 'hiring.refresh.channel', handle, backfill: true },
          })),
        )
      }
      nextBackfillDue = new Date(now + Math.max(60, backfillSeconds) * 1000)
    }

    await client.query(
      `UPDATE ${name}.scheduler_state
       SET jobs_due_at = $1,
           hiring_due_at = $2,
           backfill_due_at = $3,
           updated_at = NOW()
       WHERE id = 1`,
      [nextJobsDue, nextHiringDue, nextBackfillDue],
    )
    await client.query('COMMIT')
    return { jobsQueued, hiringQueued, backfillQueued }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function recoverExpired(maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  await initJobsPgQueue()
  const name = schema()
  await db().query(
    `UPDATE ${name}.tasks
     SET status = CASE WHEN attempts >= $1 THEN 'dead' ELSE 'pending' END,
         run_after = CASE WHEN attempts >= $1 THEN run_after ELSE NOW() END,
         locked_by = NULL,
         lock_token = NULL,
         locked_until = NULL,
         finished_at = CASE WHEN attempts >= $1 THEN COALESCE(finished_at, NOW()) ELSE NULL END,
         last_error = CASE WHEN attempts >= $1 THEN COALESCE(last_error, 'worker lease expired') ELSE last_error END,
         updated_at = NOW()
     WHERE status = 'running'
       AND locked_until IS NOT NULL
       AND locked_until < NOW()`,
    [maxAttempts],
  )
}

export async function claimJobsQueueTask({
  workerId,
  allowedTypes,
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: {
  workerId?: string
  allowedTypes?: string[]
  leaseMs?: number
  maxAttempts?: number
}) {
  await recoverExpired(maxAttempts)
  const name = schema()
  const token = randomUUID()
  const worker = String(workerId || 'jobs-worker').slice(0, 200)
  const types = Array.isArray(allowedTypes) && allowedTypes.length
    ? [...new Set(allowedTypes.map((value) => String(value).trim()).filter(Boolean))]
    : null
  const result = await db().query(
    `WITH candidate AS (
       SELECT id
       FROM ${name}.tasks
       WHERE status = 'pending'
         AND run_after <= NOW()
         AND attempts < $1
         AND ($2::text[] IS NULL OR type = ANY($2::text[]))
       ORDER BY priority DESC, run_after ASC, created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE ${name}.tasks AS task
     SET status = 'running',
         attempts = task.attempts + 1,
         locked_by = $3,
         lock_token = $4::uuid,
         locked_until = NOW() + ($5::bigint * INTERVAL '1 millisecond'),
         started_at = COALESCE(task.started_at, NOW()),
         updated_at = NOW()
     FROM candidate
     WHERE task.id = candidate.id
     RETURNING task.id, task.type, task.target, task.payload, task.attempts,
               task.lock_token, task.locked_until`,
    [Math.max(1, maxAttempts), types, worker, token, Math.max(60_000, leaseMs)],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    type: row.type as string,
    target: row.target as string,
    payload: row.payload as Record<string, unknown>,
    attempts: Number(row.attempts),
    lockToken: String(row.lock_token),
    lockedUntil: row.locked_until,
  }
}

export async function extendJobsQueueTaskLease({
  id,
  lockToken,
  leaseMs = DEFAULT_LEASE_MS,
}: {
  id: string
  lockToken: string
  leaseMs?: number
}) {
  await initJobsPgQueue()
  const name = schema()
  const updated = await db().query(
    `UPDATE ${name}.tasks
     SET locked_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'running'
       AND lock_token = $2::uuid
     RETURNING locked_until`,
    [id, lockToken, Math.max(60_000, leaseMs)],
  )
  return updated.rows[0]?.locked_until || null
}

export async function completeJobsQueueTask({
  id,
  lockToken,
  result,
}: {
  id: string
  lockToken: string
  result: unknown
}) {
  await initJobsPgQueue()
  const name = schema()
  const updated = await db().query(
    `UPDATE ${name}.tasks
     SET status = 'done',
         result = $3::jsonb,
         locked_by = NULL,
         lock_token = NULL,
         locked_until = NULL,
         last_error = NULL,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'running'
       AND lock_token = $2::uuid
     RETURNING id`,
    [id, lockToken, JSON.stringify(result ?? {})],
  )
  return updated.rowCount === 1
}

export async function failJobsQueueTask({
  id,
  lockToken,
  error,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: {
  id: string
  lockToken: string
  error: unknown
  maxAttempts?: number
}) {
  await initJobsPgQueue()
  const name = schema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query(
      `SELECT attempts FROM ${name}.tasks
       WHERE id = $1 AND status = 'running' AND lock_token = $2::uuid
       FOR UPDATE`,
      [id, lockToken],
    )
    const current = currentResult.rows[0]
    if (!current) {
      await client.query('ROLLBACK')
      return { failed: false, reason: 'lost-lease' }
    }
    const attempts = Number(current.attempts) || 1
    const dead = attempts >= Math.max(1, maxAttempts)
    const retryMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)))
    await client.query(
      `UPDATE ${name}.tasks
       SET status = $3,
           run_after = CASE WHEN $3 = 'dead' THEN run_after ELSE NOW() + ($4::bigint * INTERVAL '1 millisecond') END,
           locked_by = NULL,
           lock_token = NULL,
           locked_until = NULL,
           last_error = $5,
           finished_at = CASE WHEN $3 = 'dead' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 AND lock_token = $2::uuid`,
      [id, lockToken, dead ? 'dead' : 'pending', retryMs, String(error || 'queue task failed').slice(0, 4000)],
    )
    await client.query('COMMIT')
    return { failed: true, dead, attempts, retryMs: dead ? null : retryMs }
  } catch (error_) {
    await client.query('ROLLBACK')
    throw error_
  } finally {
    client.release()
  }
}

export async function jobsQueueStats() {
  await initJobsPgQueue()
  const name = schema()
  const result = await db().query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
       COUNT(*) FILTER (WHERE status = 'running')::integer AS running,
       COUNT(*) FILTER (WHERE status = 'done')::integer AS done,
       COUNT(*) FILTER (WHERE status = 'dead')::integer AS dead,
       MIN(run_after) FILTER (WHERE status = 'pending') AS next_run_at
     FROM ${name}.tasks`,
  )
  return result.rows[0]
}

export async function pruneJobsQueueHistory() {
  await initJobsPgQueue()
  const name = schema()
  const result = await db().query(
    `DELETE FROM ${name}.tasks
     WHERE status IN ('done', 'dead')
       AND finished_at < NOW() - ($1::integer * INTERVAL '1 day')`,
    [HISTORY_DAYS],
  )
  return result.rowCount || 0
}
