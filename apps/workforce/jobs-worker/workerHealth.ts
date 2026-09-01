import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type WorkerQueueStats = {
  pending?: number | string | null
  running?: number | string | null
  done?: number | string | null
  dead?: number | string | null
  next_run_at?: string | Date | null
}

export type WorkerHealthSnapshot = {
  workerId: string
  startedAt: string
  heartbeatAt: string
  lastDispatchAt?: string
  lastPruneAt?: string
  lastTaskStartedAt?: string
  lastTaskCompletedAt?: string
  lastTaskFailedAt?: string
  lastLoopErrorAt?: string
  lastError?: string
  activeTask?: {
    id: string
    type: string
    target: string
    attempt: number
  } | null
  queueStatsAt?: string
  queue?: {
    pending: number
    running: number
    done: number
    dead: number
    nextRunAt: string | null
  }
  queueError?: string
}

const STATE_DIR = process.env.SITE_STATE_DIR || '/var/app/state/site'
export const WORKER_HEALTH_FILE = join(STATE_DIR, 'jobs-worker-health.json')
const REPORT_INTERVAL_MS = Math.max(5_000, Number(process.env.JOBS_WORKER_HEALTH_INTERVAL_SECONDS || 20) * 1000)

function isoNow(): string {
  return new Date().toISOString()
}

function safeCount(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || 'unknown error')).slice(0, 1000)
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value)}\n`, 'utf8')
  await rename(tmp, path)
}

export async function readWorkerHealthSnapshot(path = WORKER_HEALTH_FILE): Promise<WorkerHealthSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as WorkerHealthSnapshot : null
  } catch {
    return null
  }
}

export function evaluateWorkerHealth(
  snapshot: WorkerHealthSnapshot | null,
  now = Date.now(),
  heartbeatMaxAgeMs = Math.max(30_000, Number(process.env.JOBS_WORKER_HEALTH_MAX_AGE_SECONDS || 90) * 1000),
  queueMaxAgeMs = Math.max(60_000, Number(process.env.JOBS_WORKER_QUEUE_HEALTH_MAX_AGE_SECONDS || 120) * 1000),
): { ok: boolean; reason?: string } {
  if (!snapshot) return { ok: false, reason: 'missing-health-snapshot' }

  const heartbeatAt = Date.parse(snapshot.heartbeatAt || '')
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > heartbeatMaxAgeMs) {
    return { ok: false, reason: 'stale-worker-heartbeat' }
  }

  const queueStatsAt = Date.parse(snapshot.queueStatsAt || '')
  if (!Number.isFinite(queueStatsAt) || now - queueStatsAt > queueMaxAgeMs) {
    return { ok: false, reason: 'stale-queue-health' }
  }

  return { ok: true }
}

export function createWorkerHealthReporter({
  workerId,
  getQueueStats,
  path = WORKER_HEALTH_FILE,
}: {
  workerId: string
  getQueueStats: () => Promise<WorkerQueueStats>
  path?: string
}) {
  const state: WorkerHealthSnapshot = {
    workerId,
    startedAt: isoNow(),
    heartbeatAt: isoNow(),
    activeTask: null,
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let flushing = false

  async function flush(includeQueue: boolean): Promise<void> {
    if (flushing) return
    flushing = true
    try {
      state.heartbeatAt = isoNow()
      if (includeQueue) {
        try {
          const stats = await getQueueStats()
          state.queue = {
            pending: safeCount(stats.pending),
            running: safeCount(stats.running),
            done: safeCount(stats.done),
            dead: safeCount(stats.dead),
            nextRunAt: stats.next_run_at ? new Date(stats.next_run_at).toISOString() : null,
          }
          state.queueStatsAt = isoNow()
          delete state.queueError
        } catch (error) {
          state.queueError = errorMessage(error)
        }
      }
      await atomicWriteJson(path, state)
    } catch (error) {
      console.error('[jobs:worker] health snapshot write failed:', errorMessage(error))
    } finally {
      flushing = false
    }
  }

  return {
    async start() {
      await flush(true)
      timer = setInterval(() => {
        void flush(true)
      }, REPORT_INTERVAL_MS)
      timer.unref()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      await flush(true)
    },
    markDispatch() {
      state.lastDispatchAt = isoNow()
      void flush(false)
    },
    markPrune() {
      state.lastPruneAt = isoNow()
      void flush(false)
    },
    taskStarted(task: { id: string; type: string; target: string; attempts: number }) {
      state.activeTask = {
        id: task.id,
        type: task.type,
        target: task.target,
        attempt: task.attempts,
      }
      state.lastTaskStartedAt = isoNow()
      void flush(false)
    },
    taskCompleted() {
      state.activeTask = null
      state.lastTaskCompletedAt = isoNow()
      delete state.lastError
      void flush(false)
    },
    taskFailed(error: unknown) {
      state.activeTask = null
      state.lastTaskFailedAt = isoNow()
      state.lastError = errorMessage(error)
      void flush(false)
    },
    loopError(error: unknown) {
      state.lastLoopErrorAt = isoNow()
      state.lastError = errorMessage(error)
      void flush(false)
    },
  }
}
