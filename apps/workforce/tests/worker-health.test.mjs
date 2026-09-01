import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { evaluateWorkerHealth } from '../jobs-worker/workerHealth.ts'

const worker = await readFile(new URL('../jobs-worker/worker.ts', import.meta.url), 'utf8')
const now = Date.parse('2026-08-31T07:00:00.000Z')

function snapshot(overrides = {}) {
  return {
    workerId: 'test:jobs',
    startedAt: '2026-08-31T06:50:00.000Z',
    heartbeatAt: '2026-08-31T06:59:40.000Z',
    queueStatsAt: '2026-08-31T06:59:30.000Z',
    queue: { pending: 1, running: 0, done: 10, dead: 0, nextRunAt: null },
    activeTask: null,
    ...overrides,
  }
}

test('worker health requires both a fresh event-loop heartbeat and queue observation', () => {
  assert.deepEqual(evaluateWorkerHealth(snapshot(), now, 90_000, 120_000), { ok: true })
})

test('worker health fails when the process heartbeat stops advancing', () => {
  const result = evaluateWorkerHealth(
    snapshot({ heartbeatAt: '2026-08-31T06:57:00.000Z' }),
    now,
    90_000,
    120_000,
  )
  assert.deepEqual(result, { ok: false, reason: 'stale-worker-heartbeat' })
})

test('worker health fails when PostgreSQL queue observations become stale', () => {
  const result = evaluateWorkerHealth(
    snapshot({ queueStatsAt: '2026-08-31T06:57:00.000Z' }),
    now,
    90_000,
    120_000,
  )
  assert.deepEqual(result, { ok: false, reason: 'stale-queue-health' })
})

test('worker health does not treat a missing snapshot as process health', () => {
  assert.deepEqual(
    evaluateWorkerHealth(null, now, 90_000, 120_000),
    { ok: false, reason: 'missing-health-snapshot' },
  )
})

test('worker records dispatch, pruning and task lifecycle signals', () => {
  assert.match(worker, /workerHealthReporter\.markDispatch\(\)/)
  assert.match(worker, /workerHealthReporter\.markPrune\(\)/)
  assert.match(worker, /workerHealthReporter\.taskStarted\(task\)/)
  assert.match(worker, /workerHealthReporter\.taskCompleted\(\)/)
  assert.match(worker, /workerHealthReporter\.taskFailed\(error\)/)
  assert.match(worker, /workerHealthReporter\.loopError\(error\)/)
})
