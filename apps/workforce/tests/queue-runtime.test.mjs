import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const queue = readFileSync(new URL('../shared/jobs/jobsPgQueue.ts', import.meta.url), 'utf8')
const queueMigration = readFileSync(new URL('../db/migrations/queue/001_queue_schema.sql', import.meta.url), 'utf8')
const worker = readFileSync(new URL('../jobs-worker/worker.ts', import.meta.url), 'utf8')
const jobsRuntime = readFileSync(new URL('../jobs-worker/jobsRuntime.ts', import.meta.url), 'utf8')
const hiringAdapters = readFileSync(new URL('../jobs-worker/hiringAdapters.ts', import.meta.url), 'utf8')
const dockerfile = readFileSync(new URL('../jobs-worker/Dockerfile', import.meta.url), 'utf8')

test('jobs and hiring tasks use a durable PostgreSQL queue', () => {
  assert.match(queueMigration, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.tasks/)
  assert.match(queueMigration, /CHECK \(status IN \('pending', 'running', 'done', 'dead'\)\)/)
  assert.match(queueMigration, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.scheduler_state/)
  assert.match(queueMigration, /tasks_pending_idx/)
  assert.match(queueMigration, /tasks_running_lease_idx/)

  assert.match(queue, /SELECT to_regclass\(\$1\)::text AS tasks, to_regclass\(\$2\)::text AS scheduler_state/)
  assert.match(queue, /Queue schema \$\{name\} is not migrated/)
  assert.doesNotMatch(queue, /CREATE\s+(?:SCHEMA|TABLE|INDEX)/i)
  assert.doesNotMatch(queue, /ALTER\s+TABLE/i)
  assert.match(queue, /FOR UPDATE SKIP LOCKED/)
  assert.match(queue, /pg_advisory_xact_lock/)
  assert.match(queue, /priority DESC/)
  assert.match(queue, /locked_until/)
  assert.match(queue, /run_after/)
  assert.match(queue, /scheduler_state/)
  assert.match(queue, /ON CONFLICT \(task_key\) DO NOTHING/)
  assert.match(queue, /active\.status IN \('pending', 'running'\)/)
  assert.match(queue, /LOWER\(active\.target\) = LOWER\(\$4\)/)
})

test('TypeScript worker owns queue transitions and ingestion through local runtime boundaries', () => {
  assert.match(worker, /dispatchDueJobsQueue/)
  assert.match(worker, /claimJobsQueueTask/)
  assert.match(worker, /completeJobsQueueTask/)
  assert.match(worker, /failJobsQueueTask/)
  assert.match(worker, /refreshSource\(source\)/)
  assert.match(worker, /refreshHiringTarget\(handle\)/)
  assert.doesNotMatch(worker, /\/internal\/jobs-/)
  assert.doesNotMatch(worker, /\/internal\/hiring-/)
  assert.doesNotMatch(worker, /JOBS_FRONTEND_URL|JOBS_BACKEND_URL|JOBS_API_URL/)
  assert.match(worker, /\.\.\/shared\/jobs\/jobsPgQueue/)

  assert.match(jobsRuntime, /configuredJobRefreshTargets/)
  assert.match(jobsRuntime, /refreshJobTarget/)
  assert.match(hiringAdapters, /refreshHiringChannel/)
  assert.match(hiringAdapters, /refreshHiringWebSource/)
  assert.match(hiringAdapters, /refreshHiringSocialSource/)
  assert.match(hiringAdapters, /refreshHiringLinkedInSource/)

  assert.match(dockerfile, /jobs-worker\/worker\.ts/)
  assert.doesNotMatch(dockerfile, /pip install|python/)
})
