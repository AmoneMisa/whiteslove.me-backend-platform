import type { WebCursor } from '../hiringCursors'
import { cutoffDate } from '../webFields'
import { UZJOBS_SOURCE_KEY, uzJobsIndexPageUrl } from './uzJobsSource'
import { fetchWithSourceExecutionPolicy } from '../../../packages/crawler-core/src/executionPolicy.ts'

// The previous implementation marked a cursor complete immediately after
// page 260. Treat that exact sentinel as an incomplete legacy cursor once so
// deployments already carrying it can finish the semantic walk.
const LEGACY_CAP_SENTINEL_PAGE = 261

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
  const response = await fetchWithSourceExecutionPolicy(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
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
  const legacyCapCursor = cursor.bootstrapComplete && cursor.backfillPage === LEGACY_CAP_SENTINEL_PAGE
  const backfillStart = legacyCapCursor ? 2 : Math.max(2, cursor.backfillPage || 2)
  let bootstrapComplete = cursor.bootstrapComplete && !legacyCapCursor
  const byId = new Map<string, T>()
  let fetched = 0
  let pagesRead = 0
  let lastHistoricalPage = backfillStart - 1

  const readPage = async (page: number): Promise<boolean> => {
    const parsed = parsePage(await fetchPage(page))
    pagesRead += 1
    fetched += parsed.length
    if (page > 1) lastHistoricalPage = page

    // Empty pagination is the only reliable end-of-directory signal. Last
    // visit dates are interleaved, so an old page cannot terminate backfill.
    if (!parsed.length) return false

    const recent = parsed.filter((profile) => {
      const time = Date.parse(profile.activityAt || '')
      return Number.isFinite(time)
        && time >= cutoffDate().getTime()
        && time <= Date.now() + 48 * 60 * 60 * 1000
    })
    for (const profile of recent) byId.set(profile.id, profile)
    return true
  }

  await readPage(1)
  if (!bootstrapComplete) {
    for (let page = backfillStart; ; page += 1) {
      if (!await readPage(page)) {
        bootstrapComplete = true
        break
      }
    }
  }

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
      backfillPage: Math.max(2, lastHistoricalPage + 1),
      bootstrapComplete,
      lastSuccessAt: new Date().toISOString(),
    },
  }
}
