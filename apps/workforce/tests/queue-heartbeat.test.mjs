import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const queue = await readFile(new URL('../shared/jobs/jobsPgQueue.ts', import.meta.url), 'utf8')
const worker = await readFile(new URL('../jobs-worker/worker.ts', import.meta.url), 'utf8')

test('queue exposes a token-guarded lease extension for long-running work', () => {
  assert.match(queue, /export async function extendJobsQueueTaskLease/)
  assert.match(queue, /SET locked_until = NOW\(\) \+ \(\$3::bigint \* INTERVAL '1 millisecond'\)/)
  assert.match(queue, /AND status = 'running'/)
  assert.match(queue, /AND lock_token = \$2::uuid/)
  assert.match(queue, /RETURNING locked_until/)
})

test('worker heartbeats a claimed lease only while the task is executing', () => {
  assert.match(worker, /const LEASE_HEARTBEAT_MS = Math\.max\(15_000/)
  assert.match(worker, /async function executeWithLeaseHeartbeat/)
  assert.match(worker, /extendJobsQueueTaskLease\(\{/)
  assert.match(worker, /const timer = setInterval\(heartbeat, LEASE_HEARTBEAT_MS\)/)
  assert.match(worker, /clearInterval\(timer\)/)
  assert.match(worker, /if \(lostLease\) throw new Error\('execution lost queue lease'\)/)
  assert.match(worker, /const result = await executeWithLeaseHeartbeat\(task\)/)
})
