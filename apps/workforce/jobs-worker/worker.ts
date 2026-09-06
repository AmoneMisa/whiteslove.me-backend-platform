import { looksSoftBlocked } from '../shared/http/browserSoftBlock'
import { loadCursors, loadWebCursors } from '../shared/hiring/hiringCursors'
import {
  claimJobsQueueTask,
  completeJobsQueueTask,
  dispatchDueJobsQueue,
  extendJobsQueueTaskLease,
  failJobsQueueTask,
  jobsQueueDbEnabled,
  pruneJobsQueueHistory,
} from '../shared/jobs/jobsPgQueue'
import { allHiringTargets, refreshHiringTarget } from './hiringRuntime'
import { communityJobBoardHosts, configuredSources, refreshSource } from './jobsRuntime'
import { WORKER_HEALTH_ID, workerHealthReporter } from './workerHealthRuntime'

const POLL_MS = Math.max(250, Number(process.env.JOBS_QUEUE_POLL_MS) || Number(process.env.JOBS_QUEUE_POLL_SECONDS || 1) * 1000)
const ERROR_RETRY_MS = Math.max(1_000, Number(process.env.JOBS_QUEUE_ERROR_RETRY_MS) || 5_000)
const DISPATCH_INTERVAL_MS = Math.max(5_000, Number(process.env.JOBS_QUEUE_DISPATCH_TICK_SECONDS || 10) * 1000)
const HISTORY_PRUNE_INTERVAL_MS = Math.max(60_000, Number(process.env.JOBS_QUEUE_HISTORY_PRUNE_SECONDS || 21_600) * 1000)
const LEASE_HEARTBEAT_MS = Math.max(15_000, Number(process.env.JOBS_QUEUE_HEARTBEAT_SECONDS || 60) * 1000)
const LEASE_EXTENSION_MS = Math.max(
  LEASE_HEARTBEAT_MS * 2,
  Number(process.env.JOBS_QUEUE_LEASE_SECONDS || 240) * 1000,
)
const WORKER_ID = WORKER_HEALTH_ID
const WORKFORCE_DOMAIN = String(process.env.WORKFORCE_DOMAIN || '').trim().toLowerCase()
if (!['vacancies', 'cv'].includes(WORKFORCE_DOMAIN)) {
  throw new Error('WORKFORCE_DOMAIN must be vacancies or cv')
}
const ALLOWED_TASK_TYPES = WORKFORCE_DOMAIN === 'vacancies'
  ? ['jobs.refresh.source']
  : ['hiring.refresh.channel']

let stopping = false
let lastDispatchAt = 0
let lastPruneAt = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function normalizedHost(value: string): string {
  return value.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
}

function installJobSourceOverrides() {
  const staleIntelliasLever = /^https:\/\/api\.lever\.co\/v0\/postings\/intellias(?:\?|$)/i
  const originalFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let url: string
    try {
      url = input instanceof Request ? input.url : String(input)
    } catch {
      return originalFetch(input, init)
    }

    if (staleIntelliasLever.test(url)) {
      return new Response('[]', {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Job-Source-Override': 'intellias-wp-api',
        },
      })
    }

    return originalFetch(input, init)
  }) as typeof globalThis.fetch
}

function installJobBrowserFallback() {
  const endpoint = String(process.env.JOB_BROWSER_FETCHER_URL || '').trim().replace(/\/+$/, '')
  if (!endpoint) return

  const failureStatuses = new Set([403, 429, 500, 502, 503, 504])
  const hosts = new Set([
    'flagma.uz',
    'flagma.ro',
    'flagma.kg',
    'jobs.ua',
    'work.ua',
    'robota.ua',
    'djinni.co',
    'jobs.dou.ua',
    'api.hh.ru',
    'hh.kz',
    'headhunter.kg',
    'resume.uz',
    'enbek.kz',
    'qsamruk.kz',
    'newjob.kg',
    'kyzmat.gov.kg',
    'ejobs.ro',
    'bestjobs.eu',
    'hipo.ro',
    'taskfavour.com',
    'remote.co',
    'simplyhired.com',
    'visajobsearch.com',
    'visajobfinder.com',
    'migratemate.co',
    'gcsservices.careers.microsoft.com',
    ...communityJobBoardHosts(),
  ])
  for (const raw of String(process.env.JOB_BROWSER_ALLOWED_HOSTS || '').split(',')) {
    const host = normalizedHost(raw.trim())
    if (host) hosts.add(host)
  }

  const originalFetch = globalThis.fetch.bind(globalThis)
  const proxyTimeoutMs = Math.max(5_000, Number(process.env.JOB_BROWSER_PROXY_TIMEOUT_MS) || 65_000)
  const failureCooldownMs = Math.max(30_000, Number(process.env.JOB_BROWSER_FAILURE_COOLDOWN_MS) || 300_000)
  const failedUntil = new Map<string, number>()

  const browserFallback = async (url: URL, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))

    return originalFetch(`${endpoint}/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url.toString(),
        accept: headers.get('accept') || undefined,
        acceptLanguage: headers.get('accept-language') || undefined,
      }),
      signal: AbortSignal.timeout(proxyTimeoutMs),
    })
  }

  const coolDown = (host: string) => failedUntil.set(host, Date.now() + failureCooldownMs)

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let url: URL
    try {
      url = input instanceof Request ? new URL(input.url) : new URL(String(input))
    } catch {
      return originalFetch(input, init)
    }

    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (url.protocol !== 'https:' || method !== 'GET') return originalFetch(input, init)

    const host = normalizedHost(url.hostname)
    if (!hosts.has(host)) return originalFetch(input, init)

    const blockedUntil = failedUntil.get(host) || 0
    if (blockedUntil > Date.now()) {
      return new Response('upstream temporarily cooling down', {
        status: 503,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))) },
      })
    }
    failedUntil.delete(host)

    let primaryResponse: Response | undefined
    let primaryError: unknown
    try {
      primaryResponse = await originalFetch(input, init)
      if (!failureStatuses.has(primaryResponse.status)) {
        const contentType = primaryResponse.headers.get('content-type') || ''
        if (!contentType.includes('html')) return primaryResponse
        const html = await primaryResponse.clone().text().catch(() => '')
        if (!looksSoftBlocked(html)) {
          return new Response(html, {
            status: primaryResponse.status,
            statusText: primaryResponse.statusText,
            headers: primaryResponse.headers,
          })
        }
      }
    } catch (error) {
      primaryError = error
    }

    try {
      const fallback = await browserFallback(url, input, init)
      if (fallback.ok) {
        const contentType = fallback.headers.get('content-type') || ''
        if (contentType.includes('html')) {
          const html = await fallback.clone().text().catch(() => '')
          if (looksSoftBlocked(html)) {
            coolDown(host)
            return new Response('upstream challenge persisted after browser fallback', {
              status: 502,
              headers: { 'Retry-After': String(Math.ceil(failureCooldownMs / 1000)) },
            })
          }
        }
        failedUntil.delete(host)
      } else if (failureStatuses.has(fallback.status)) {
        coolDown(host)
      }
      return fallback
    } catch (fallbackError) {
      coolDown(host)
      if (primaryResponse) return primaryResponse
      throw primaryError instanceof Error ? primaryError : fallbackError
    }
  }) as typeof globalThis.fetch
}

async function dispatchDueTasks() {
  const { telegramHandles, progressiveWebHandles, hiringHandles } = WORKFORCE_DOMAIN === 'cv'
    ? allHiringTargets()
    : { telegramHandles: [], progressiveWebHandles: [], hiringHandles: [] }
  const [telegramCursors, webCursors] = WORKFORCE_DOMAIN === 'cv'
    ? await Promise.all([loadCursors(), loadWebCursors()])
    : [new Map(), new Map()]
  const backfillHandles = [
    ...telegramHandles.filter((handle) => !telegramCursors.get(handle)?.bootstrapComplete),
    ...progressiveWebHandles.filter((handle) => {
      const key = handle.replace(/^web:/i, '')
      return !webCursors.get(key)?.bootstrapComplete
    }),
  ]

  const result = await dispatchDueJobsQueue({
    sources: WORKFORCE_DOMAIN === 'vacancies' ? configuredSources() : [],
    hiringHandles,
    backfillHandles,
    jobsRefreshSeconds: Math.max(60, Number(process.env.JOBS_QUEUE_REFRESH_SECONDS) || 1800),
    hiringRefreshSeconds: Math.max(60, Number(process.env.HIRING_QUEUE_REFRESH_SECONDS) || 1800),
    backfillSeconds: Math.max(60, Number(process.env.HIRING_QUEUE_BACKFILL_SECONDS) || 300),
    jobsEnabled: WORKFORCE_DOMAIN === 'vacancies',
    hiringEnabled: WORKFORCE_DOMAIN === 'cv'
      && String(process.env.HIRING_QUEUE_ENABLED || 'on').toLowerCase() !== 'off',
  })

  const queued = result.jobsQueued + result.hiringQueued + result.backfillQueued
  if (queued) {
    console.log(
      `[jobs:worker] queued jobs=${result.jobsQueued} hiring=${result.hiringQueued} backfill=${result.backfillQueued}`,
    )
  }
}

async function executeTask(task: Awaited<ReturnType<typeof claimJobsQueueTask>>) {
  if (!task) return null
  const payload = task.payload || {}

  if (task.type === 'jobs.refresh.source') {
    if (WORKFORCE_DOMAIN !== 'vacancies') throw new Error('CV worker cannot execute vacancy tasks')
    const source = String(payload.source || task.target || '')
    if (!source) throw new Error('jobs task has no source')
    return { source, ...(await refreshSource(source)) }
  }

  if (task.type === 'hiring.refresh.channel') {
    if (WORKFORCE_DOMAIN !== 'cv') throw new Error('Vacancies worker cannot execute CV tasks')
    const handle = String(payload.handle || task.target || '')
    if (!handle) throw new Error('hiring task has no handle')
    return refreshHiringTarget(handle)
  }

  throw new Error(`Unsupported queue task type: ${task.type || '<empty>'}`)
}

async function executeWithLeaseHeartbeat(task: NonNullable<Awaited<ReturnType<typeof claimJobsQueueTask>>>) {
  let heartbeatRunning = false
  let heartbeatPromise: Promise<void> | null = null
  let lostLease = false

  const heartbeat = () => {
    if (heartbeatRunning || lostLease) return
    heartbeatRunning = true
    heartbeatPromise = extendJobsQueueTaskLease({
      id: task.id,
      lockToken: task.lockToken,
      leaseMs: LEASE_EXTENSION_MS,
    })
      .then((lockedUntil) => {
        if (!lockedUntil) lostLease = true
      })
      .catch((error) => {
        console.error(
          `[jobs:worker] lease heartbeat failed task=${task.id}:`,
          error instanceof Error ? error.message : String(error),
        )
      })
      .finally(() => {
        heartbeatRunning = false
      })
  }

  const timer = setInterval(heartbeat, LEASE_HEARTBEAT_MS)
  timer.unref()

  try {
    const result = await executeTask(task)
    clearInterval(timer)
    if (heartbeatPromise) await heartbeatPromise
    if (lostLease) throw new Error('execution lost queue lease')
    return result
  } finally {
    clearInterval(timer)
  }
}

async function processOneTask() {
  const task = await claimJobsQueueTask({ workerId: WORKER_ID, allowedTypes: ALLOWED_TASK_TYPES })
  if (!task) return false

  workerHealthReporter.taskStarted(task)
  try {
    console.log(`[jobs:worker] start ${task.type} target=${task.target} attempt=${task.attempts}`)
    const result = await executeWithLeaseHeartbeat(task)
    const completed = await completeJobsQueueTask({
      id: task.id,
      lockToken: task.lockToken,
      result,
    })
    if (!completed) throw new Error('completion lost queue lease')
    workerHealthReporter.taskCompleted()
    console.log(`[jobs:worker] completed ${task.type} target=${task.target}`)
  } catch (error) {
    workerHealthReporter.taskFailed(error)
    const message = error instanceof Error ? error.message : String(error)
    try {
      const outcome = await failJobsQueueTask({
        id: task.id,
        lockToken: task.lockToken,
        error: message,
      })
      console.error(
        `[jobs:worker] failed ${task.type} target=${task.target} `
        + `attempt=${task.attempts} dead=${Boolean(outcome.dead)}: ${message}`,
      )
    } catch (failError) {
      console.error(
        `[jobs:worker] failed to transition task ${task.id}:`,
        failError instanceof Error ? failError.message : String(failError),
      )
    }
  }

  return true
}

async function main() {
  if (!jobsQueueDbEnabled()) {
    throw new Error('JOBS_QUEUE_DATABASE_URL or HIRING_DATABASE_URL is required')
  }

  installJobBrowserFallback()
  installJobSourceOverrides()

  console.log(`[${WORKFORCE_DOMAIN}:worker] direct TypeScript worker started id=${WORKER_ID}`)

  while (!stopping) {
    try {
      const now = Date.now()
      if (now - lastDispatchAt >= DISPATCH_INTERVAL_MS) {
        await dispatchDueTasks()
        lastDispatchAt = Date.now()
        workerHealthReporter.markDispatch()
      }
      if (now - lastPruneAt >= HISTORY_PRUNE_INTERVAL_MS) {
        const pruned = await pruneJobsQueueHistory()
        if (pruned) console.log(`[jobs:worker] pruned ${pruned} completed queue tasks`)
        lastPruneAt = Date.now()
        workerHealthReporter.markPrune()
      }

      const processed = await processOneTask()
      if (!processed) await sleep(POLL_MS)
    } catch (error) {
      workerHealthReporter.loopError(error)
      console.error('[jobs:worker] loop error:', error instanceof Error ? error.message : String(error))
      await sleep(ERROR_RETRY_MS)
    }
  }

  console.log('[jobs:worker] stopped')
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true
  })
}

main().catch((error) => {
  workerHealthReporter.loopError(error)
  console.error('[jobs:worker] fatal:', error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
