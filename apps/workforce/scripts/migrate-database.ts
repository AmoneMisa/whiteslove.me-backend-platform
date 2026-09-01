import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient } from 'pg'

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i
const ROOT = fileURLToPath(new URL('../db/migrations/', import.meta.url))

type MigrationTarget = {
  name: 'jobs' | 'hiring' | 'queue'
  url: string
  schema: string
  directory: string
}

function safeSchema(value: string, fallback: string): string {
  const candidate = String(value || fallback).trim()
  if (!SCHEMA_RE.test(candidate)) {
    throw new Error(`Invalid database schema name: ${candidate}`)
  }
  return candidate
}

function configuredUrl(...values: Array<string | undefined>): string {
  for (const value of values) {
    const candidate = String(value || '').trim()
    if (candidate) return candidate
  }
  return ''
}

function migrationTargets(): MigrationTarget[] {
  const runtimeHiringUrl = configuredUrl(process.env.HIRING_DATABASE_URL)
  const runtimeJobsUrl = configuredUrl(process.env.JOBS_DATABASE_URL, runtimeHiringUrl)
  const runtimeQueueUrl = configuredUrl(process.env.JOBS_QUEUE_DATABASE_URL, runtimeHiringUrl)

  return [
    {
      name: 'jobs',
      url: configuredUrl(process.env.JOBS_MIGRATION_DATABASE_URL, runtimeJobsUrl),
      schema: safeSchema(process.env.JOBS_DB_SCHEMA || '', 'jobs'),
      directory: join(ROOT, 'jobs'),
    },
    {
      name: 'hiring',
      url: configuredUrl(process.env.HIRING_MIGRATION_DATABASE_URL, runtimeHiringUrl),
      schema: safeSchema(process.env.HIRING_DB_SCHEMA || '', 'hiring'),
      directory: join(ROOT, 'hiring'),
    },
    {
      name: 'queue',
      url: configuredUrl(process.env.JOBS_QUEUE_MIGRATION_DATABASE_URL, runtimeQueueUrl),
      schema: safeSchema(process.env.JOBS_QUEUE_DB_SCHEMA || '', 'site_queue'),
      directory: join(ROOT, 'queue'),
    },
  ].filter((target) => target.url)
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

async function migrationFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => /^\d+[_-].+\.sql$/u.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function ensureMigrationTable(client: PoolClient, target: MigrationTarget): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${target.schema}`)
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${target.schema}._site_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function applyMigration(
  client: PoolClient,
  target: MigrationTarget,
  version: string,
  sql: string,
): Promise<'applied' | 'existing'> {
  const digest = checksum(sql)
  const existing = await client.query<{ checksum: string }>(
    `SELECT checksum FROM ${target.schema}._site_migrations WHERE version = $1`,
    [version],
  )
  if (existing.rows[0]) {
    if (existing.rows[0].checksum !== digest) {
      throw new Error(
        `${target.name} migration ${version} changed after it was applied; create a new migration instead`,
      )
    }
    return 'existing'
  }

  const rendered = sql.replaceAll('{{schema}}', target.schema)
  await client.query('BEGIN')
  try {
    await client.query(rendered)
    await client.query(
      `INSERT INTO ${target.schema}._site_migrations (version, checksum) VALUES ($1, $2)`,
      [version, digest],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
  return 'applied'
}

async function migrateTarget(target: MigrationTarget): Promise<void> {
  const pool = new Pool({
    connectionString: target.url,
    max: 1,
    connectionTimeoutMillis: 10_000,
  })
  const client = await pool.connect()
  const lockName = `personal-site:migrations:${target.schema}`
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName])
    await ensureMigrationTable(client, target)

    const files = await migrationFiles(target.directory)
    for (const version of files) {
      const sql = await readFile(join(target.directory, version), 'utf8')
      const result = await applyMigration(client, target, version, sql)
      console.log(`[db:migrate] ${target.name}/${target.schema} ${version}: ${result}`)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => {})
    client.release()
    await pool.end()
  }
}

async function main(): Promise<void> {
  const targets = migrationTargets()
  if (!targets.length) {
    console.log('[db:migrate] no configured databases')
    return
  }

  for (const target of targets) {
    await migrateTarget(target)
  }
}

main().catch((error) => {
  console.error('[db:migrate] failed:', error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
