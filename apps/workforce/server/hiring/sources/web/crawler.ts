import type { CvProfile } from '../../../../shared/contracts/hiring'
import { emptyWebCursor, type WebCursor } from '../../../../shared/hiring/hiringCursors'
import { candidateBlocks, mergeSameCandidate, type WebCvAdapter } from './common'
import { fetchHiringWebPage } from './http'

const DEFAULT_MAX_PAGES = 5

export interface WebAdapterRun {
  profiles: CvProfile[]
  fetched: number
  pages: number
  parsed: number
  rejected: number
  duplicate: number
  cursor: WebCursor
  newestActivityAt: string | null
  oldestActivityAt: string | null
  reachedCursor: boolean
}

export function webProfileId(url: string): string {
  const patterns = [
    /resume_view-(\d+)/i,
    /\/resume\/([a-f0-9]{16,})/i,
    /-rr(\d+)\.html/i,
    /\/cv\/list\/([a-z0-9]{8,})/i,
    /\/candidates\/(\d+)/i,
    /~(\d{5,})(?:[/?#]|$)/i,
    /-(\d{5,})\.html/i,
    /\/resumes\/(\d+)/i,
    /[#&](?:candidate|resume)=([a-z0-9-]{8,})/i,
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]!
  }
  return url
}

export async function crawlWebAdapter(
  source: WebCvAdapter,
  cursor: WebCursor = emptyWebCursor(source.key),
): Promise<WebAdapterRun> {
  const byUrl = new Map<string, CvProfile>()
  const run: WebAdapterRun = {
    profiles: [], fetched: 0, pages: 0, parsed: 0, rejected: 0, duplicate: 0,
    cursor: { ...cursor }, newestActivityAt: null, oldestActivityAt: null, reachedCursor: false,
  }

  const maxPages = Math.max(1, Math.min(20, Number(process.env.HIRING_WEB_CV_MAX_PAGES) || DEFAULT_MAX_PAGES))
  const backfillPages = Math.max(1, Math.min(10, Number(process.env.HIRING_WEB_CV_BACKFILL_PAGES) || DEFAULT_MAX_PAGES - 1))
  let newestSeen: CvProfile | null = null
  let reachedKnown = false

  const readPage = async (
    page: number,
    options: { stopAtCursor: boolean; trackNewest: boolean },
  ): Promise<{ blocks: number; recent: number }> => {
    const html = await fetchHiringWebPage(source.pageUrl(page))
    run.pages += 1
    const blocks = candidateBlocks(html, source, page)
    if (!blocks.length) return { blocks: 0, recent: 0 }
    run.fetched += blocks.length

    let recentOnPage = 0
    for (const block of blocks) {
      const profile = source.parse(block, source)
      if (!profile) {
        run.rejected += 1
        continue
      }
      run.parsed += 1
      recentOnPage += 1

      const activity = profile.activityAt || profile.updatedAt || null
      if (activity) {
        if (!run.newestActivityAt || activity > run.newestActivityAt) run.newestActivityAt = activity
        if (!run.oldestActivityAt || activity < run.oldestActivityAt) run.oldestActivityAt = activity
      }
      if (options.trackNewest && !newestSeen) newestSeen = profile

      const identity = webProfileId(profile.url)
      if (options.stopAtCursor && cursor.lastSeenProfileId && identity === cursor.lastSeenProfileId) {
        reachedKnown = true
        run.reachedCursor = true
        break
      }

      const previous = byUrl.get(profile.url)
      if (previous) run.duplicate += 1
      byUrl.set(profile.url, previous ? mergeSameCandidate(previous, profile) : profile)
    }
    return { blocks: blocks.length, recent: recentOnPage }
  }

  const incrementalPages = cursor.lastSeenProfileId ? maxPages : 1
  for (let page = 1; page <= incrementalPages && !reachedKnown; page++) {
    const result = await readPage(page, { stopAtCursor: true, trackNewest: true })
    if (!result.blocks || !result.recent) break
  }

  let nextBackfillPage = Math.max(2, cursor.backfillPage || 1)
  let bootstrapComplete = cursor.bootstrapComplete
  if (!bootstrapComplete) {
    const startPage = nextBackfillPage
    let lastPage = startPage - 1
    for (let page = startPage; page < startPage + backfillPages; page++) {
      lastPage = page
      const result = await readPage(page, { stopAtCursor: false, trackNewest: false })
      if (!result.blocks || !result.recent) {
        bootstrapComplete = true
        break
      }
    }
    if (!bootstrapComplete) nextBackfillPage = Math.max(startPage + 1, lastPage)
  }

  run.cursor = newestSeen
    ? {
        ...cursor,
        sourceKey: source.key,
        lastSeenProfileId: webProfileId(newestSeen.url),
        lastSeenUrl: newestSeen.url,
        lastSeenUpdatedAt: newestSeen.activityAt || newestSeen.updatedAt || null,
        backfillPage: nextBackfillPage,
        bootstrapComplete,
        lastSuccessAt: new Date().toISOString(),
      }
    : {
        ...cursor,
        sourceKey: source.key,
        backfillPage: nextBackfillPage,
        bootstrapComplete,
        lastSuccessAt: new Date().toISOString(),
      }

  run.profiles = [...byUrl.values()]
  return run
}
