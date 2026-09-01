import { Client } from 'pg'

import { jobsDbEnabled } from '../server/jobs/infrastructure/database'
import {
  backfillDbCandidateReadModel,
  hiringDbEnabled,
  loadDbCandidates,
} from '../server/hiring/infrastructure/database'
import { jobsQueueDbEnabled, jobsQueueStats } from '../shared/jobs/jobsPgQueue'

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i

function jobsRuntimeSchema(): string {
  const raw = String(process.env.JOBS_DB_SCHEMA || 'jobs').trim()
  return SCHEMA_RE.test(raw) ? raw : 'jobs'
}

async function verifyJobsRuntimeRead(): Promise<void> {
  const connectionString = String(
    process.env.JOBS_DATABASE_URL || process.env.HIRING_DATABASE_URL || '',
  ).trim()
  if (!connectionString) throw new Error('Jobs runtime database URL is missing')

  const schema = jobsRuntimeSchema()
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 })
  try {
    await client.connect()
    const relation = await client.query('SELECT to_regclass($1)::text AS vacancies', [`${schema}.vacancies`])
    if (!relation.rows[0]?.vacancies) {
      throw new Error(`Jobs runtime schema ${schema} is not migrated`)
    }
    await client.query(`SELECT 1 FROM ${schema}.vacancies LIMIT 1`)
  } finally {
    await client.end().catch(() => {})
  }
}

async function main() {
  const prepared: string[] = []

  if (jobsDbEnabled()) {
    // Test the runtime credential itself, not the migration credential. Unlike a
    // public lookup helper this path deliberately propagates permission/schema
    // errors so rollout cannot continue with a non-readable Jobs database.
    await verifyJobsRuntimeRead()
    prepared.push('jobs')
  }

  if (hiringDbEnabled()) {
    // Legacy row hydration is an explicit deployment operation. HTTP reads never
    // mutate old rows or rebuild the current-candidate projection anymore.
    await backfillDbCandidateReadModel()
    await loadDbCandidates()
    prepared.push('hiring')
  }

  if (jobsQueueDbEnabled()) {
    await jobsQueueStats()
    prepared.push('site_queue')
  }

  console.log(`[db:prepare] ready: ${prepared.join(', ') || 'no configured databases'}`)
}

main().catch((error) => {
  console.error('[db:prepare] failed:', error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
