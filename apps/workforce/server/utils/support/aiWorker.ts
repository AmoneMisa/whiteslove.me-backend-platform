import { createHash } from 'node:crypto'

export type AiKind = 'vacancy' | 'candidate' | 'apartment' | 'translation'

export type AiExtractionResult<T = Record<string, unknown>> = {
  status: 'completed'
  data: T
  confidence: number
  lowConfidence?: boolean
}

type AiTask<T> = {
  id: string
  kind: AiKind
  rawText: string
  knownFacts: Record<string, unknown>
  meta?: Record<string, unknown>
  fingerprint: string
  onResult: (result: AiExtractionResult<T>) => void | Promise<void>
  onFailed?: (status: string) => void | Promise<void>
}

type SubmitResponse<T> = AiExtractionResult<T> & {
  key?: string
} | {
  status: 'pending' | 'failed' | 'disabled' | 'not_found'
  key?: string
}

type AiWorkerRequestError = Error & { status?: number }

const workerUrl = (process.env.AI_WORKER_URL || '').replace(/\/$/, '')
const workerKey = process.env.AI_WORKER_KEY || ''
// Translation is interactive and a single 3s control-plane timeout used to make
// the browser abandon an otherwise healthy queued inference job. Keep at least 10s
// even when an older production .env still contains AI_WORKER_REQUEST_TIMEOUT_MS=3000.
const requestTimeoutMs = Math.max(10_000, Number(process.env.AI_WORKER_REQUEST_TIMEOUT_MS) || 0)
const proxyRequestRetries = Math.max(0, Number(process.env.AI_WORKER_PROXY_RETRIES) || 1)
const pollIntervalMs = Math.max(1_000, Number(process.env.AI_WORKER_POLL_MS) || 5_000)
const maxQueued = Math.max(1, Number(process.env.AI_WORKER_MAX_PENDING) || 60)
const submitConcurrency = Math.max(1, Number(process.env.AI_WORKER_SUBMIT_CONCURRENCY) || 4)

const queue: AiTask<unknown>[] = []
const pending = new Map<string, AiTask<unknown>>()
const scheduled = new Set<string>()
let activeSubmissions = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
let lastWarningAt = 0

function warn(message: string) {
  if (Date.now() - lastWarningAt < 60_000) return
  lastWarningAt = Date.now()
  console.warn(`[ai-worker] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function aiFingerprint(kind: AiKind, rawText: string, knownFacts: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${kind}\0${rawText.replace(/\s+/g, ' ').trim()}\0${stable(knownFacts)}`)
    .digest('hex')
    .slice(0, 24)
}

export function aiWorkerEnabled(): boolean {
  return Boolean(workerUrl)
}

export function isAiWorkerTransientError(error: unknown): boolean {
  const requestError = error as AiWorkerRequestError
  if (typeof requestError?.status === 'number') {
    return requestError.status === 408 || requestError.status === 429 || requestError.status >= 500
  }
  return requestError?.name === 'TimeoutError'
    || requestError?.name === 'AbortError'
    || requestError?.name === 'TypeError'
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  if (init?.body) headers.set('content-type', 'application/json')
  if (workerKey) headers.set('x-ai-key', workerKey)

  const response = await fetch(`${workerUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`) as AiWorkerRequestError
    error.status = response.status
    throw error
  }
  return await response.json() as T
}

// Server routes may proxy an on-demand job without exposing the private worker
// URL or X-AI-Key to the browser. Interactive proxy calls get one quick retry on
// transport/5xx failures; background enrichment keeps its existing queue logic.
export async function requestAiWorker<T>(path: string, init?: RequestInit): Promise<T> {
  if (!workerUrl) throw new Error('AI worker is not configured')

  let lastError: unknown
  for (let attempt = 0; attempt <= proxyRequestRetries; attempt += 1) {
    try {
      return await request<T>(path, init)
    } catch (error) {
      lastError = error
      if (!isAiWorkerTransientError(error) || attempt >= proxyRequestRetries) throw error
      await sleep(250 * (attempt + 1))
    }
  }
  throw lastError
}

async function finish<T>(task: AiTask<T>, result: AiExtractionResult<T>) {
  scheduled.delete(task.fingerprint)
  try {
    await task.onResult(result)
  } catch (error) {
    warn(`result merge failed for ${task.id}: ${(error as Error).message}`)
  }
}

async function fail(task: AiTask<unknown>, status: string) {
  scheduled.delete(task.fingerprint)
  try {
    await task.onFailed?.(status)
  } catch (error) {
    warn(`failure callback failed for ${task.id}: ${(error as Error).message}`)
  }
}

function schedulePoll() {
  if (pollTimer || pending.size === 0) return
  pollTimer = setTimeout(() => {
    pollTimer = undefined
    void pollPending()
  }, pollIntervalMs)
  pollTimer.unref?.()
}

async function pollPending() {
  const batch = [...pending.entries()].slice(0, submitConcurrency * 2)
  await Promise.all(batch.map(async ([key, task]) => {
    try {
      const result = await request<SubmitResponse<unknown>>(`/ai/result/${encodeURIComponent(key)}`)
      if (result.status === 'completed') {
        pending.delete(key)
        await finish(task, result)
      } else if (result.status === 'failed' || result.status === 'not_found' || result.status === 'disabled') {
        pending.delete(key)
        await fail(task, result.status)
      }
    } catch (error) {
      warn(`poll unavailable: ${(error as Error).message}`)
    }
  }))
  schedulePoll()
}

async function submit(task: AiTask<unknown>) {
  try {
    const result = await request<SubmitResponse<unknown>>('/ai/extract', {
      method: 'POST',
      body: JSON.stringify({
        kind: task.kind,
        rawText: task.rawText,
        knownFacts: task.knownFacts,
        meta: task.meta || {},
      }),
    })
    if (result.status === 'completed') {
      await finish(task, result)
    } else if (result.status === 'pending' && result.key) {
      pending.set(result.key, task)
      schedulePoll()
    } else {
      await fail(task, result.status)
    }
  } catch (error) {
    warn(`submission unavailable: ${(error as Error).message}`)
    await fail(task, 'unavailable')
  } finally {
    activeSubmissions -= 1
    pump()
  }
}

function pump() {
  while (activeSubmissions < submitConcurrency && queue.length) {
    const task = queue.shift()
    if (!task) break
    activeSubmissions += 1
    void submit(task)
  }
}

export function scheduleAiExtraction<T>(task: Omit<AiTask<T>, 'fingerprint'> & { fingerprint?: string }): boolean {
  if (!aiWorkerEnabled() || !task.rawText.trim()) return false
  const fingerprint = task.fingerprint || aiFingerprint(task.kind, task.rawText, task.knownFacts)
  if (scheduled.has(fingerprint) || queue.length + pending.size + activeSubmissions >= maxQueued) return false

  scheduled.add(fingerprint)
  queue.push({ ...task, fingerprint } as AiTask<unknown>)
  pump()
  return true
}
