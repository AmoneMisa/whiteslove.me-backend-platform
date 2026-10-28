import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = await mkdtemp(join(tmpdir(), 'jobs-store-'))
process.env.SITE_STATE_DIR = stateDir
process.env.JOBS_DB_SCHEMA = 'jobs'
delete process.env.JOBS_DATABASE_URL
delete process.env.HIRING_DATABASE_URL

const { PersistentStateStore, jsonStringBody } = await import('../server/utils/support/stateStore.ts')
const refresh = await import('../server/vacancies/application/jobsSourceRefresh.ts')
const database = await import('../server/jobs/infrastructure/database.ts')

test.after(() => rm(stateDir, { recursive: true, force: true }))

test('the default store is the snapshot; PostgreSQL needs the flag and a configured database', () => {
  delete process.env.JOBS_STORE
  assert.equal(refresh.jobsStoreMode(), 'snapshot')
  process.env.JOBS_STORE = 'postgres'
  assert.equal(refresh.jobsStoreMode(), 'snapshot', 'no database configured: stay on the snapshot')
  process.env.JOBS_DATABASE_URL = 'postgresql://user@localhost/none'
  assert.equal(refresh.jobsStoreMode(), 'postgres')
  process.env.JOBS_STORE = 'Snapshot'
  assert.equal(refresh.jobsStoreMode(), 'snapshot')
  delete process.env.JOBS_STORE
  delete process.env.JOBS_DATABASE_URL
})

test('a value written in pieces reads back exactly like one written whole', async () => {
  const store = new PersistentStateStore()
  const jobs = [
    { id: '1', title: 'Разработчик "Node"', description: 'строка\nс переводом\tи "кавычками" \\ слэшем   emoji 👩‍💻' },
    { id: '2', title: 'Dev', description: '' },
  ]
  const whole = JSON.stringify(jobs)
  const body = jobs.map((job) => JSON.stringify(job)).join(',')
  async function* pieces() {
    yield '['
    yield body.slice(0, 25)
    yield body.slice(25)
    yield ']'
  }
  assert.equal(await store.setStream('jobs:test:stream', pieces(), 'EX', 60), 'OK')
  assert.equal(await store.get('jobs:test:stream'), whole)
  assert.equal(jsonStringBody('a"b\n'), 'a\\"b\\n')
})

test('a stream that fails midway leaves neither a temporary file nor a changed value', async () => {
  const store = new PersistentStateStore()
  await store.set('jobs:test:keep', 'before')
  async function* broken() {
    yield '['
    throw new Error('database went away')
  }
  await assert.rejects(store.setStream('jobs:test:keep', broken()), /database went away/)
  assert.equal(await store.get('jobs:test:keep'), 'before')
  assert.deepEqual((await readdir(stateDir)).filter((name) => name.endsWith('.tmp')), [])
})

test('the snapshot is exported page by page and parses as the array of live vacancies', async () => {
  const live = Array.from({ length: 2500 }, (_, i) => ({ id: `job-${i}`, title: `T ${i}`, lastSeen: '2026-10-28T00:00:00.000Z' }))
  const page = async (after, limit) => {
    const start = after ? live.findIndex((job) => job.id === after) + 1 : 0
    const jobs = live.slice(start, start + limit)
    return { jobs, lastKey: jobs.length ? jobs[jobs.length - 1].id : null }
  }
  let text = ''
  for await (const piece of refresh.snapshotPieces(page)) text += piece
  assert.deepEqual(JSON.parse(text), live)
  await assert.rejects(
    async () => { for await (const piece of refresh.snapshotPieces(async () => ({ jobs: [], lastKey: null }))) void piece },
    /no live vacancies/,
    'an empty table is not published over the old snapshot',
  )
})

test('the state directory sweep removes only old temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-sweep-'))
  try {
    const old = join(dir, 'a.json.1.x.tmp')
    const fresh = join(dir, 'b.json.2.y.tmp')
    const real = join(dir, 'c.json')
    for (const path of [old, fresh, real]) await writeFile(path, '{}')
    const longAgo = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(old, longAgo, longAgo)
    await utimes(real, longAgo, longAgo)
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, [
      '--experimental-transform-types', '--import', './jobs-worker/alias-loader.mjs', '-e',
      "const { PersistentStateStore } = await import('./server/utils/support/stateStore.ts'); await new PersistentStateStore().get('probe')",
    ], { cwd: new URL('..', import.meta.url), env: { ...process.env, SITE_STATE_DIR: dir }, stdio: 'ignore' })
    assert.deepEqual((await readdir(dir)).sort(), ['b.json.2.y.tmp', 'c.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the incremental upsert is the existing one plus last_seen_at, and never moves it backwards', () => {
  const sql = database.SEEN_UPSERT_SQL('jobs')
  assert.match(sql, /INSERT INTO jobs\.vacancies \([^)]*cluster_key, data, last_seen_at, updated_at/)
  assert.match(sql, /input\.cluster_key, input\.data, input\.last_seen_at, NOW\(\)/)
  assert.match(sql, /data JSONB,\s+last_seen_at TIMESTAMPTZ/)
  assert.match(sql, /last_seen_at = GREATEST\(jobs\.vacancies\.last_seen_at, EXCLUDED\.last_seen_at\)/)
  assert.match(sql, /jobs\.vacancies\.last_seen_at < EXCLUDED\.last_seen_at - INTERVAL '1 hour'/)
  assert.match(sql, /\(jobs\.vacancies\.data - 'lastSeen'\) IS DISTINCT FROM \(EXCLUDED\.data - 'lastSeen'\)/, 'still skips unchanged rows')
  assert.match(database.CLUSTER_RECOUNT_SQL('jobs'), /v\.active = TRUE AND v\.cluster_key = k\.cluster_key/)
})

test('without a configured database the incremental operations do nothing and read nothing', async () => {
  delete process.env.JOBS_DATABASE_URL
  assert.equal(await database.upsertJobsIncremental([{ id: 'x', source: 'hh', title: 't' }]), 0)
  assert.deepEqual(await database.closeJobsByKeys(['hh:x']), [])
  assert.deepEqual(await database.pruneJobs({ maxAgeDays: 14, staleDays: 4 }), [])
  assert.deepEqual(await database.listActiveJobsPage(null, 10), { jobs: [], lastKey: null })
  assert.deepEqual(await database.listJobsNeedingAi(10), [])
  assert.equal((await database.loadJobsAiState(['hh:x'])).size, 0)
})

test('migration 005 adds the column without a default and the runtime stays DDL-free', async () => {
  const { readFile } = await import('node:fs/promises')
  const migration = await readFile(new URL('../db/migrations/jobs/005_last_seen.sql', import.meta.url), 'utf8')
  assert.match(migration, /ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;/)
  assert.doesNotMatch(migration, /last_seen_at TIMESTAMPTZ\s+(NOT NULL|DEFAULT)/i, 'no table rewrite')
  assert.match(migration, /WHERE active = TRUE AND last_seen_at IS NOT NULL/)
  const runtime = await readFile(new URL('../server/jobs/infrastructure/database.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(runtime, /\b(?:CREATE|ALTER)\s+(?:SCHEMA|TABLE|INDEX)\b/i)
})
