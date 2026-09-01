import { useStateStore } from './stateStore'
import type { Job } from './jobTypes'

const CURSOR_VERSION = 1
const CURSOR_TTL_SECONDS = 30 * 86_400

/**
 * Canonical crawl policy for ordinary vacancy boards.
 *
 * New source adapters must consume this policy through the shared crawler
 * instead of inventing local execution limits or traversal behavior. Source-
 * specific overrides are only for a documented upstream contract requirement.
 */
export const STANDARD_JOB_BOARD_CRAWL_POLICY = Object.freeze({
  pagesPerRun: 2,
  maxPage: 10_000,
  requestDelayMs: 500,
})

interface JobBoardCursor {
  version: number
  nextPage: number
  cycle: number
  lastSuccessAt: string | null
}

interface OpaqueJobBoardCursor {
  version: number
  nextCursor: string | null
  cycle: number
  lastSuccessAt: string | null
}

export interface CyclicJobBoardRun {
  jobs: Job[]
  pages: number[]
  nextPage: number
  cycle: number
  reachedEnd: boolean
}

export interface CursorJobBoardRun {
  jobs: Job[]
  cursors: Array<string | null>
  nextCursor: string | null
  cycle: number
  reachedEnd: boolean
}

export interface CyclicJobBoardOptions {
  key: string
  pagesPerRun: number
  maxPage: number
  fetchPage: (page: number) => Promise<string>
  parsePage: (html: string, page: number) => Job[]
  requestDelayMs?: number
  stopOnRepeatedPage?: boolean
}

export interface StandardJobBoardOptions {
  key: string
  fetchPage: (page: number) => Promise<string>
  parsePage: (html: string, page: number) => Job[]
}

export interface CursorJobBoardOptions {
  key: string
  pagesPerRun: number
  fetchPage: (cursor: string | null) => Promise<string>
  parsePage: (raw: string, cursor: string | null) => Job[]
  nextCursor: (raw: string) => string | null
  requestDelayMs?: number
}

export interface StandardCursorJobBoardOptions {
  key: string
  fetchPage: (cursor: string | null) => Promise<string>
  parsePage: (raw: string, cursor: string | null) => Job[]
  nextCursor: (raw: string) => string | null
}

export interface StandardJobBoardDetailOptions {
  key: string
  jobs: Job[]
  fetchDetail: (job: Job) => Promise<string>
  parseDetail: (raw: string, summary: Job) => Job | null
}

function defaultCursor(): JobBoardCursor {
  return {
    version: CURSOR_VERSION,
    nextPage: 2,
    cycle: 0,
    lastSuccessAt: null,
  }
}

function defaultOpaqueCursor(): OpaqueJobBoardCursor {
  return {
    version: CURSOR_VERSION,
    nextCursor: null,
    cycle: 0,
    lastSuccessAt: null,
  }
}

function cursorKey(key: string): string {
  return `jobs:board-cursor:v${CURSOR_VERSION}:${key}`
}

function opaqueCursorKey(key: string): string {
  return `jobs:board-opaque-cursor:v${CURSOR_VERSION}:${key}`
}

async function loadCursor(key: string): Promise<JobBoardCursor> {
  const raw = await useStateStore().get(cursorKey(key))
  if (!raw) return defaultCursor()
  try {
    const parsed = JSON.parse(raw) as Partial<JobBoardCursor>
    return {
      version: CURSOR_VERSION,
      nextPage: Math.max(2, Number(parsed.nextPage) || 2),
      cycle: Math.max(0, Number(parsed.cycle) || 0),
      lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
    }
  } catch {
    return defaultCursor()
  }
}

async function loadOpaqueCursor(key: string): Promise<OpaqueJobBoardCursor> {
  const raw = await useStateStore().get(opaqueCursorKey(key))
  if (!raw) return defaultOpaqueCursor()
  try {
    const parsed = JSON.parse(raw) as Partial<OpaqueJobBoardCursor>
    return {
      version: CURSOR_VERSION,
      nextCursor: typeof parsed.nextCursor === 'string' && parsed.nextCursor ? parsed.nextCursor : null,
      cycle: Math.max(0, Number(parsed.cycle) || 0),
      lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
    }
  } catch {
    return defaultOpaqueCursor()
  }
}

async function saveCursor(key: string, cursor: JobBoardCursor): Promise<void> {
  await useStateStore().set(
    cursorKey(key),
    JSON.stringify(cursor),
    'EX',
    CURSOR_TTL_SECONDS,
  )
}

async function saveOpaqueCursor(key: string, cursor: OpaqueJobBoardCursor): Promise<void> {
  await useStateStore().set(
    opaqueCursorKey(key),
    JSON.stringify(cursor),
    'EX',
    CURSOR_TTL_SECONDS,
  )
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function dedupe(jobs: Job[]): Job[] {
  const byKey = new Map<string, Job>()
  for (const job of jobs) byKey.set(job.url || job.id, job)
  return [...byKey.values()]
}

function pageSignature(jobs: Job[]): string {
  return jobs.map((job) => job.url || job.id).sort().join('\n')
}

/**
 * Refreshes page 1 on every run and rotates through older pages with a durable
 * cursor. Rotation intentionally never becomes permanently "complete": job
 * snapshots expire when a source has not re-seen them for a few days, so a
 * 14-day board window must be revisited continuously rather than backfilled
 * once and forgotten.
 */
export async function crawlCyclicJobBoard(options: CyclicJobBoardOptions): Promise<CyclicJobBoardRun> {
  const pagesPerRun = Math.max(1, Math.min(50, options.pagesPerRun))
  const maxPage = Math.max(2, Math.min(10_000, options.maxPage))
  const requestDelayMs = Math.max(0, Math.min(10_000, options.requestDelayMs || 0))
  const cursor = await loadCursor(options.key)
  const startPage = Math.min(maxPage, Math.max(2, cursor.nextPage))
  const historicalPages = Array.from(
    { length: Math.min(pagesPerRun, maxPage - startPage + 1) },
    (_, index) => startPage + index,
  )
  const pages = [1, ...historicalPages]
  const jobs: Job[] = []
  const readPages: number[] = []
  let nextPage = startPage
  let reachedEnd = false
  let failedHistoricalPage: number | null = null
  let firstSignature: string | null = null
  let previousHistoricalSignature: string | null = null

  for (const page of pages) {
    if (readPages.length) await delay(requestDelayMs)
    try {
      const pageJobs = options.parsePage(await options.fetchPage(page), page)
      const signature = pageSignature(pageJobs)

      if (page === 1) {
        firstSignature = signature
      } else if (
        options.stopOnRepeatedPage
        && signature
        && (signature === firstSignature || signature === previousHistoricalSignature)
      ) {
        reachedEnd = true
        break
      }

      readPages.push(page)
      jobs.push(...pageJobs)

      if (page > 1) {
        previousHistoricalSignature = signature
        if (!pageJobs.length) {
          reachedEnd = true
          break
        }
        nextPage = page + 1
        if (nextPage > maxPage) reachedEnd = true
      }
    } catch (error) {
      if (page === 1) throw error
      failedHistoricalPage = page
      console.warn(
        `[jobs] ${options.key} pagination paused at page ${page}:`,
        error instanceof Error ? error.message : String(error),
      )
      break
    }
  }

  if (failedHistoricalPage != null) nextPage = failedHistoricalPage
  const cycle = reachedEnd ? cursor.cycle + 1 : cursor.cycle
  if (reachedEnd) nextPage = 2

  await saveCursor(options.key, {
    version: CURSOR_VERSION,
    nextPage,
    cycle,
    lastSuccessAt: new Date().toISOString(),
  })

  return {
    jobs: dedupe(jobs),
    pages: readPages,
    nextPage,
    cycle,
    reachedEnd,
  }
}

/**
 * Standard page-number crawler used by registry-style public vacancy boards.
 * It is deliberately opinionated so adapters do not grow their own traversal,
 * pacing or durable cursor behavior.
 */
export function crawlStandardJobBoard(options: StandardJobBoardOptions): Promise<CyclicJobBoardRun> {
  return crawlCyclicJobBoard({
    ...options,
    pagesPerRun: STANDARD_JOB_BOARD_CRAWL_POLICY.pagesPerRun,
    maxPage: STANDARD_JOB_BOARD_CRAWL_POLICY.maxPage,
    requestDelayMs: STANDARD_JOB_BOARD_CRAWL_POLICY.requestDelayMs,
    stopOnRepeatedPage: true,
  })
}

/**
 * Shared detail stage for boards whose list pages only expose summaries.
 * Source adapters provide only transport and parsing facts; traversal/pacing
 * remains part of the crawler rather than source-local execution policy.
 */
export async function enrichStandardJobBoardDetails(options: StandardJobBoardDetailOptions): Promise<Job[]> {
  const summaries = dedupe(options.jobs)
  const output: Job[] = []

  for (const summary of summaries) {
    if (output.length) await delay(STANDARD_JOB_BOARD_CRAWL_POLICY.requestDelayMs)
    try {
      const raw = await options.fetchDetail(summary)
      output.push(options.parseDetail(raw, summary) || summary)
    } catch (error) {
      console.warn(
        `[jobs] ${options.key} detail failed ${summary.url}:`,
        error instanceof Error ? error.message : String(error),
      )
      output.push(summary)
    }
  }

  return output
}

/**
 * Cursor-based sibling of crawlCyclicJobBoard. Page 1 is still refreshed every
 * run; older pages resume from a durable opaque cursor supplied by the source.
 */
export async function crawlCursorJobBoard(options: CursorJobBoardOptions): Promise<CursorJobBoardRun> {
  const pagesPerRun = Math.max(1, Math.min(50, options.pagesPerRun))
  const requestDelayMs = Math.max(0, Math.min(10_000, options.requestDelayMs || 0))
  const saved = await loadOpaqueCursor(options.key)
  const jobs: Job[] = []
  const cursors: Array<string | null> = []

  const firstRaw = await options.fetchPage(null)
  const firstJobs = options.parsePage(firstRaw, null)
  const firstNextCursor = options.nextCursor(firstRaw)
  jobs.push(...firstJobs)
  cursors.push(null)

  let nextCursor = saved.nextCursor || firstNextCursor
  let reachedEnd = !nextCursor
  let failedCursor: string | null = null

  for (let index = 0; index < pagesPerRun && nextCursor; index += 1) {
    await delay(requestDelayMs)
    const currentCursor = nextCursor
    try {
      const raw = await options.fetchPage(currentCursor)
      const pageJobs = options.parsePage(raw, currentCursor)
      jobs.push(...pageJobs)
      cursors.push(currentCursor)
      nextCursor = options.nextCursor(raw)
      if (!nextCursor) reachedEnd = true
    } catch (error) {
      failedCursor = currentCursor
      console.warn(
        `[jobs] ${options.key} cursor pagination paused:`,
        error instanceof Error ? error.message : String(error),
      )
      break
    }
  }

  if (failedCursor) nextCursor = failedCursor
  const cycle = reachedEnd ? saved.cycle + 1 : saved.cycle
  if (reachedEnd) nextCursor = firstNextCursor

  await saveOpaqueCursor(options.key, {
    version: CURSOR_VERSION,
    nextCursor,
    cycle,
    lastSuccessAt: new Date().toISOString(),
  })

  return {
    jobs: dedupe(jobs),
    cursors,
    nextCursor,
    cycle,
    reachedEnd,
  }
}

export function crawlStandardCursorJobBoard(options: StandardCursorJobBoardOptions): Promise<CursorJobBoardRun> {
  return crawlCursorJobBoard({
    ...options,
    pagesPerRun: STANDARD_JOB_BOARD_CRAWL_POLICY.pagesPerRun,
    requestDelayMs: STANDARD_JOB_BOARD_CRAWL_POLICY.requestDelayMs,
  })
}
