import type { WebCursor } from '../hiringCursors'
import { cutoffDate } from '../webFields'
import { UZJOBS_SOURCE_KEY, uzJobsIndexPageUrl } from './uzJobsSource'

const REQUEST_TIMEOUT_MS = 25_000
const MAX_BACKFILL_PAGES = 60
const DEFAULT_BACKFILL_PAGES = 40
const MAX_INDEX_PAGE = 260
const FETCH_CONCURRENCY = 4
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export interface UzJobsCrawlProfile {
  id: string
  activityAt?: string | null
  url?: string | null
}

export interface UzJobsCrawlResult<T extends UzJobsCrawlProfile> {
  profiles: T[]
  fetched: number
  pages: number
  cursor: WebCursor
}

async function fetchPage(page: number): Promise<string> {
  const url = uzJobsIndexPageUrl(page)
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)

  // UzJobs declares Windows-1251. Response.text() would decode it as UTF-8 and
  // silently corrupt Cyrillic professions and regions.
  return new TextDecoder('windows-1251').decode(await response.arrayBuffer())
}

/**
 * Network/pagination policy for the public UzJobs resume directory.
 * Parsing and normalization stay injected so the crawler remains independent
 * from Nitro and from candidate persistence.
 */
export async function crawlUzJobsPages<T extends UzJobsCrawlProfile>(
  cursor: WebCursor,
  parsePage: (html: string) => T[],
): Promise<UzJobsCrawlResult<T>> {
  const backfillPages = Math.max(1, Math.min(
    MAX_BACKFILL_PAGES,
    Number(process.env.HIRING_UZJOBS_BACKFILL_PAGES) || DEFAULT_BACKFILL_PAGES,
  ))
  const savedBackfillPage = Math.max(2, cursor.backfillPage || 2)

  // Older production cursors could be marked complete after a page with no
  // recent rows. Only a cursor beyond the hard cap proves the current crawler
  // reached the directory end/cap.
  const legacyPrematureComplete = cursor.bootstrapComplete && savedBackfillPage <= MAX_INDEX_PAGE
  const backfillStart = savedBackfillPage
  let bootstrapComplete = cursor.bootstrapComplete && !legacyPrematureComplete
  if (backfillStart > MAX_INDEX_PAGE) bootstrapComplete = true

  const historicalPages = bootstrapComplete
    ? []
    : Array.from(
      { length: Math.min(backfillPages, MAX_INDEX_PAGE - backfillStart + 1) },
      (_, index) => backfillStart + index,
    )
  const pages = bootstrapComplete ? [1] : [1, ...historicalPages]
  const byId = new Map<string, T>()
  let fetched = 0
  let pagesRead = 0
  let lastHistoricalPage = backfillStart - 1
  let reachedDirectoryEnd = false

  for (let offset = 0; offset < pages.length; offset += FETCH_CONCURRENCY) {
    const batch = pages.slice(offset, offset + FETCH_CONCURRENCY)
    const results = await Promise.all(batch.map(async (page) => ({
      page,
      parsed: parsePage(await fetchPage(page)),
    })))

    for (const { page, parsed } of results) {
      pagesRead += 1
      fetched += parsed.length
      if (page > 1) lastHistoricalPage = page

      // Empty pagination is the only reliable end-of-directory signal. Last
      // visit dates are interleaved, so an old page cannot terminate backfill.
      if (!parsed.length) {
        if (page > 1) {
          bootstrapComplete = true
          reachedDirectoryEnd = true
        }
        continue
      }

      const recent = parsed.filter((profile) => {
        const time = Date.parse(profile.activityAt || '')
        return Number.isFinite(time)
          && time >= cutoffDate().getTime()
          && time <= Date.now() + 48 * 60 * 60 * 1000
      })
      for (const profile of recent) byId.set(profile.id, profile)
    }

    if (reachedDirectoryEnd) break
  }

  if (!bootstrapComplete && lastHistoricalPage >= MAX_INDEX_PAGE) bootstrapComplete = true

  const profiles = [...byId.values()]
  const newest = [...profiles]
    .sort((a, b) => Date.parse(b.activityAt || '') - Date.parse(a.activityAt || ''))[0]

  return {
    profiles,
    fetched,
    pages: pagesRead,
    cursor: {
      ...cursor,
      sourceKey: UZJOBS_SOURCE_KEY,
      lastSeenProfileId: newest?.id.replace(`web-${UZJOBS_SOURCE_KEY}-`, '') || cursor.lastSeenProfileId,
      lastSeenUrl: newest?.url || cursor.lastSeenUrl,
      lastSeenUpdatedAt: newest?.activityAt || cursor.lastSeenUpdatedAt,
      backfillPage: bootstrapComplete
        ? MAX_INDEX_PAGE + 1
        : Math.max(2, lastHistoricalPage),
      bootstrapComplete,
      lastSuccessAt: new Date().toISOString(),
    },
  }
}
