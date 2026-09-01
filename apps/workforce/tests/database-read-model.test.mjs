import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const readRoot = (path) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')

const runner = await read('scripts/migrate-database.ts')
const prepare = await read('scripts/prepare-database-schema.ts')
const jobsRuntime = await read('server/jobs/infrastructure/database.ts')
const hiringRuntime = await read('server/hiring/infrastructure/database.ts')
const hiringCurrent = await read('server/hiring/infrastructure/currentCandidateReadModel.ts')
const queueRuntime = await read('shared/jobs/jobsPgQueue.ts')
const jobsMigration = await read('db/migrations/jobs/001_initial_read_model.sql')
const hiringMigration = await read('db/migrations/hiring/001_candidate_read_model.sql')
const queueMigration = await read('db/migrations/queue/001_queue_schema.sql')
const jobsFeed = await read('server/routes/jobs-feed.get.ts')
const hiringFeed = await read('server/routes/hiring-feed.get.ts')
const jobsSourceRefresh = await read('server/vacancies/application/jobsSourceRefresh.ts')
const compose = parse(await readRoot('docker-compose.yml'))

test('workforce schemas keep explicit ordered versioned migrations', () => {
  assert.match(jobsMigration, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.vacancies/)
  assert.match(hiringMigration, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.candidates/)
  assert.match(hiringMigration, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.candidate_current/)
  assert.match(queueMigration, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.tasks/)
  assert.match(queueMigration, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.scheduler_state/)

  assert.match(runner, /_site_migrations/)
  assert.match(runner, /createHash\('sha256'\)/)
  assert.match(runner, /changed after it was applied/)
  assert.match(runner, /pg_advisory_lock\(hashtext\(\$1\)\)/)
  assert.match(runner, /\.sort\(\(a, b\) => a\.localeCompare\(b, 'en'\)\)/)
  assert.match(runner, /sql\.replaceAll\('\{\{schema\}\}', target\.schema\)/)
})

test('runtime database modules stay DDL-free and require migrated relations', () => {
  for (const runtime of [jobsRuntime, hiringRuntime, hiringCurrent, queueRuntime]) {
    assert.doesNotMatch(runtime, /\bCREATE\s+(?:SCHEMA|TABLE|INDEX)\b/i)
    assert.doesNotMatch(runtime, /\bALTER\s+TABLE\b/i)
  }

  assert.match(jobsRuntime, /to_regclass/)
  assert.match(jobsRuntime, /run scripts\/migrate-database\.ts before runtime/)
  assert.match(hiringRuntime, /to_regclass/)
  assert.match(hiringRuntime, /export async function backfillDbCandidateReadModel/)
  assert.match(queueRuntime, /to_regclass/)
  assert.match(queueRuntime, /run scripts\/migrate-database\.ts before runtime/)
  assert.match(prepare, /await backfillDbCandidateReadModel\(\)/)
})

test('backend platform Compose owns workforce migrations before APIs and workers', () => {
  const services = compose.services || {}
  for (const migration of ['workforce-queue-migrate', 'vacancies-migrate', 'cv-migrate']) {
    assert.ok(services[migration], `${migration} service is required`)
    assert.equal(services[migration].restart, 'no')
  }

  assert.equal(services['vacancies-api']?.depends_on?.['vacancies-migrate']?.condition, 'service_completed_successfully')
  assert.equal(services['cv-api']?.depends_on?.['cv-migrate']?.condition, 'service_completed_successfully')
  assert.equal(services['vacancies-worker']?.depends_on?.['vacancies-migrate']?.condition, 'service_completed_successfully')
  assert.equal(services['vacancies-worker']?.depends_on?.['workforce-queue-migrate']?.condition, 'service_completed_successfully')
  assert.equal(services['cv-worker']?.depends_on?.['cv-migrate']?.condition, 'service_completed_successfully')
  assert.equal(services['cv-worker']?.depends_on?.['workforce-queue-migrate']?.condition, 'service_completed_successfully')
})

test('vacancy PostgreSQL read model stays indexed and is synchronized by ingestion', () => {
  assert.match(jobsRuntime, /JOBS_DB_SCHEMA \|\| 'jobs'/)
  assert.match(jobsRuntime, /vacancies_active_posted_idx|jobStatsCache/)
  assert.match(jobsMigration, /vacancies_active_posted_idx/)
  assert.match(jobsMigration, /vacancies_city_lower_idx[\s\S]*LOWER\(city\)/)
  assert.match(jobsMigration, /vacancies_skills_gin_idx[\s\S]*USING GIN\(skills\)/)
  assert.match(jobsMigration, /vacancies_search_idx[\s\S]*to_tsvector\('simple', search_text\)/)
  assert.match(jobsSourceRefresh, /await syncJobsDb\(kept\)/)

  const dbIndex = jobsFeed.indexOf('await queryJobsDb(jobQuery)')
  const snapshotIndex = jobsFeed.indexOf('await getStoredSnapshot()')
  assert.ok(dbIndex > -1 && snapshotIndex > -1 && dbIndex < snapshotIndex)
  assert.match(jobsFeed, /engine: 'postgresql'/)
})

test('vacancy analytics remain bounded instead of serializing the full salary corpus', () => {
  assert.match(jobsRuntime, /const JOB_STATS_CACHE_TTL_MS = 60_000/)
  assert.match(jobsRuntime, /const JOB_SALARY_TREND_MAX_POINTS = 750/)
  assert.match(jobsRuntime, /PARTITION BY date_trunc\('day', posted_at\), COALESCE\(country, ''\), profession/u)
  assert.match(jobsRuntime, /WHERE sample_rank <= 3/u)
  assert.match(jobsRuntime, /LIMIT \$\{JOB_SALARY_TREND_MAX_POINTS\}/u)
  assert.match(jobsRuntime, /percentile_cont\(0\.5\)/)
})

test('candidate reads use the indexed PostgreSQL read model and database analytics', () => {
  assert.match(hiringMigration, /candidates_active_activity_idx/)
  assert.match(hiringMigration, /candidates_city_lower_idx[\s\S]*LOWER\(canonical_city\)/)
  assert.match(hiringMigration, /candidates_professions_gin_idx[\s\S]*USING GIN\(professions\)/)
  assert.match(hiringMigration, /candidates_search_idx[\s\S]*to_tsvector\('simple', search_text\)/)
  assert.match(hiringRuntime, /export async function queryDbCandidates/)
  assert.match(hiringRuntime, /salary_experience/)
  assert.match(hiringRuntime, /salary_profession/)
  assert.match(hiringRuntime, /activity_counts/)
  assert.match(hiringFeed, /await queryDbCandidates\(params, offset, limit\)/)
  assert.match(hiringFeed, /engine: 'postgresql'/)
})
