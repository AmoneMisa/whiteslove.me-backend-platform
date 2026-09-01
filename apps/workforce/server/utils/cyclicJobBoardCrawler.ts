import {
  crawlCyclic,
  crawlCursor,
  enrichDetails,
  STANDARD_CRAWL_POLICY,
  type CrawlerStateStore,
} from '../../packages/crawler-core/src/index.ts'
import { useStateStore } from './stateStore'
import type { Job } from '~~/shared/contracts/jobs'

const JOB_CRAWLER_NAMESPACE = 'jobs:board'
const JOB_CRAWLER_LOG_PREFIX = '[jobs]'
const JOB_MAX_AGE_DAYS = 14
const NON_VACANCY_KINDS = new Set([
  'candidate',
  'vacancy_digest',
  'recruitment_ad',
  'course',
  'job_service',
  'closed_vacancy',
  'spam',
])

/**
 * Canonical transport policy for ordinary vacancy boards.
 *
 * Traversal completion is semantic: vacancy type + the site-wide 14-day
 * retention window, or natural source exhaustion. Source adapters never own a
 * page/result/run cap.
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
  /** @deprecated Kept only for source compatibility; crawler-core ignores it. */
  pagesPerRun?: number
  /** @deprecated Kept only for source compatibility; crawler-core ignores it. */
  maxPage?: number
  fetchPage: (page: number) => Promise<string>
  parsePage: (html: string, page: number) => Job[]
  requestDelayMs?: number
  shouldStop?: (jobs: Job[], page: number) => boolean
  acceptItem?: (job: Job) => boolean
  stopOnRepeatedPage?: boolean
}

export interface StandardJobBoardOptions {
  key: string
  fetchPage: (page: number) => Promise<string>
  parsePage: (html: string, page: number) => Job[]
}

export interface CursorJobBoardOptions {
  key: string
  /** @deprecated Kept only for source compatibility; crawler-core ignores it. */
  pagesPerRun?: number
  fetchPage: (cursor: string | null) => Promise<string>
  parsePage: (raw: string, cursor: string | null) => Job[]
  nextCursor: (raw: string) => string | null
  requestDelayMs?: number
  shouldStop?: (jobs: Job[], cursor: string | null) => boolean
  acceptItem?: (job: Job) => boolean
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

function isVacancy(job: Job): boolean {
  if (job.vacancyStatus === 'closed') return false
  return !job.hiringKind || !NON_VACANCY_KINDS.has(job.hiringKind)
}

function reachedJobDateBoundary(jobs: Job[]): boolean {
  const cutoff = Date.now() - JOB_MAX_AGE_DAYS * 86_400_000
  return jobs.some((job) => {
    const postedAt = Date.parse(job.postedAt)
    return Number.isFinite(postedAt) && postedAt < cutoff
  })
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
    requestDelayMs: STANDARD_JOB_BOARD_CRAWL_POLICY.requestDelayMs,
    shouldStop: reachedJobDateBoundary,
    acceptItem: isVacancy,
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
    requestDelayMs: STANDARD_JOB_BOARD_CRAWL_POLICY.requestDelayMs,
    shouldStop: reachedJobDateBoundary,
    acceptItem: isVacancy,
  })
}
