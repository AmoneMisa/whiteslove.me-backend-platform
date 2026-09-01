import {
  crawlCyclic,
  crawlCursor,
  enrichDetails,
  STANDARD_CRAWL_POLICY,
  type CrawlerStateStore,
} from '../../packages/crawler-core/src/index.ts'
import { useStateStore } from './stateStore'
import type { Job } from './jobTypes'

const JOB_CRAWLER_NAMESPACE = 'jobs:board'
const JOB_CRAWLER_LOG_PREFIX = '[jobs]'

/**
 * Canonical crawl policy for ordinary vacancy boards.
 *
 * Execution mechanics live in crawler-core. Vacancy adapters only provide
 * source transport and parsing facts, never local traversal policy.
 */
export const STANDARD_JOB_BOARD_CRAWL_POLICY = STANDARD_CRAWL_POLICY

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

function crawlerState(): CrawlerStateStore {
  return useStateStore() as unknown as CrawlerStateStore
}

function jobKey(job: Job): string {
  return job.url || job.id
}

export async function crawlCyclicJobBoard(options: CyclicJobBoardOptions): Promise<CyclicJobBoardRun> {
  const run = await crawlCyclic<Job>({
    ...options,
    namespace: JOB_CRAWLER_NAMESPACE,
    state: crawlerState(),
    itemKey: jobKey,
    logPrefix: JOB_CRAWLER_LOG_PREFIX,
  })

  return {
    jobs: run.items,
    pages: run.pages,
    nextPage: run.nextPage,
    cycle: run.cycle,
    reachedEnd: run.reachedEnd,
  }
}

export function crawlStandardJobBoard(options: StandardJobBoardOptions): Promise<CyclicJobBoardRun> {
  return crawlCyclicJobBoard({
    ...options,
    pagesPerRun: STANDARD_JOB_BOARD_CRAWL_POLICY.pagesPerRun,
    maxPage: STANDARD_JOB_BOARD_CRAWL_POLICY.maxPage,
    requestDelayMs: STANDARD_JOB_BOARD_CRAWL_POLICY.requestDelayMs,
    stopOnRepeatedPage: true,
  })
}

export function enrichStandardJobBoardDetails(options: StandardJobBoardDetailOptions): Promise<Job[]> {
  return enrichDetails<Job>({
    key: options.key,
    items: options.jobs,
    itemKey: jobKey,
    requestDelayMs: STANDARD_JOB_BOARD_CRAWL_POLICY.requestDelayMs,
    logPrefix: JOB_CRAWLER_LOG_PREFIX,
    fetchDetail: options.fetchDetail,
    parseDetail: options.parseDetail,
  })
}

export async function crawlCursorJobBoard(options: CursorJobBoardOptions): Promise<CursorJobBoardRun> {
  const run = await crawlCursor<Job>({
    ...options,
    namespace: JOB_CRAWLER_NAMESPACE,
    state: crawlerState(),
    itemKey: jobKey,
    logPrefix: JOB_CRAWLER_LOG_PREFIX,
  })

  return {
    jobs: run.items,
    cursors: run.cursors,
    nextCursor: run.nextCursor,
    cycle: run.cycle,
    reachedEnd: run.reachedEnd,
  }
}

export function crawlStandardCursorJobBoard(options: StandardCursorJobBoardOptions): Promise<CursorJobBoardRun> {
  return crawlCursorJobBoard({
    ...options,
    pagesPerRun: STANDARD_JOB_BOARD_CRAWL_POLICY.pagesPerRun,
    requestDelayMs: STANDARD_JOB_BOARD_CRAWL_POLICY.requestDelayMs,
  })
}
