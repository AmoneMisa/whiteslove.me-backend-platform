import type { CvProfile } from '../../../../shared/contracts/hiring'
import { emptyWebCursor, type WebCursor } from '../../../../shared/hiring/hiringCursors'
import { activityDate, cityFrom, htmlText, isRecent } from '../../../../shared/hiring/webFields'
import { buildWebProfile, type CandidateBlock, type WebCvAdapter } from './common'
import { webProfileId, type WebAdapterRun } from './crawler'
import { fetchHiringWebPage } from './http'

const DEFAULT_MAX_PAGES = 5

function resumeRole(lines: string[]): string {
  const roleLine = lines.find((line) => line.includes(' / ') && !/field of activity|position/i.test(line))
  if (!roleLine) return ''
  return roleLine.split('/').map((part) => part.trim()).filter(Boolean).at(-1) || roleLine
}

function rowCandidate(rowHtml: string): { id: string; block: CandidateBlock } | null {
  const prepared = rowHtml.replace(/<\/(?:td|th)>/gi, '</td>\n')
  const text = htmlText(prepared)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)

  const hrefMatch = rowHtml.match(/href=["'][^"']*resume_view-(\d+)-[^"']*["']/i)
  const standaloneId = lines.find((line) => /^\d{4,8}$/.test(line))
  const leadingId = text.match(/^\s*(\d{4,8})\b/)
  const id = hrefMatch?.[1] || standaloneId || leadingId?.[1] || ''
  if (!id) return null

  const role = resumeRole(lines)
  if (!role) return null

  const href = `https://uzjobs.uz/e/resume_view-${id}-1-1.html`
  return {
    id,
    block: {
      href,
      title: role,
      html: rowHtml,
      text,
    },
  }
}

function parseUzJobsBlock(block: CandidateBlock, source: WebCvAdapter): CvProfile | null {
  const activity = activityDate(block.text)
  if (!isRecent(activity)) return null

  return buildWebProfile(source, block, activity!, {
    role: block.title,
    city: cityFrom(block.text, 'UZ'),
    updatedAt: activity,
    // Public directory rows are anonymized and never expose a direct contact.
    // Numeric ids and activity timestamps must not be inferred as phone data.
    contactType: 'platform',
    contact: block.href,
    contacts: {},
  })
}

export const UZJOBS_SOURCE: WebCvAdapter = {
  key: 'uzjobs-resumes',
  label: 'UzJobs · resumes',
  country: 'UZ',
  root: 'https://uzjobs.uz/e/resume-2-1.html',
  pageUrl: (page) => `https://uzjobs.uz/e/resume-2-${Math.max(1, page)}.html`,
  linkRe: /uzjobs\.uz\/e\/resume_view-\d+-/i,
  parse: parseUzJobsBlock,
}

export function parseUzJobsResumeRows(html: string): CvProfile[] {
  const profiles: CvProfile[] = []
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []

  for (const row of rows) {
    const candidate = rowCandidate(row)
    if (!candidate) continue
    const profile = parseUzJobsBlock(candidate.block, UZJOBS_SOURCE)
    if (profile) profiles.push(profile)
  }

  return profiles
}

export async function crawlUzJobs(
  cursor: WebCursor = emptyWebCursor(UZJOBS_SOURCE.key),
): Promise<WebAdapterRun> {
  const run: WebAdapterRun = {
    profiles: [],
    fetched: 0,
    pages: 0,
    parsed: 0,
    rejected: 0,
    duplicate: 0,
    cursor: { ...cursor },
    newestActivityAt: null,
    oldestActivityAt: null,
    reachedCursor: false,
  }
  const byUrl = new Map<string, CvProfile>()
  const maxPages = Math.max(1, Math.min(20, Number(process.env.HIRING_WEB_CV_MAX_PAGES) || DEFAULT_MAX_PAGES))
  const backfillPages = Math.max(1, Math.min(10, Number(process.env.HIRING_WEB_CV_BACKFILL_PAGES) || DEFAULT_MAX_PAGES - 1))
  let newestSeen: CvProfile | null = null
  let reachedKnown = false

  const readPage = async (page: number, stopAtCursor: boolean, trackNewest: boolean) => {
    const html = await fetchHiringWebPage(UZJOBS_SOURCE.pageUrl(page))
    run.pages += 1
    const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []
    run.fetched += rows.length
    let recentOnPage = 0

    for (const row of rows) {
      const candidate = rowCandidate(row)
      if (!candidate) {
        run.rejected += 1
        continue
      }
      const profile = parseUzJobsBlock(candidate.block, UZJOBS_SOURCE)
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
      if (trackNewest && !newestSeen) newestSeen = profile

      const identity = webProfileId(profile.url)
      if (stopAtCursor && cursor.lastSeenProfileId && identity === cursor.lastSeenProfileId) {
        reachedKnown = true
        run.reachedCursor = true
        break
      }

      const previous = byUrl.get(profile.url)
      if (previous) run.duplicate += 1
      byUrl.set(profile.url, profile)
    }

    return { rows: rows.length, recent: recentOnPage }
  }

  const incrementalPages = cursor.lastSeenProfileId ? maxPages : 1
  for (let page = 1; page <= incrementalPages && !reachedKnown; page++) {
    const result = await readPage(page, true, true)
    if (!result.rows || !result.recent) break
  }

  let nextBackfillPage = Math.max(2, cursor.backfillPage || 1)
  let bootstrapComplete = cursor.bootstrapComplete
  if (!bootstrapComplete) {
    const startPage = nextBackfillPage
    let lastPage = startPage - 1
    for (let page = startPage; page < startPage + backfillPages; page++) {
      lastPage = page
      const result = await readPage(page, false, false)
      if (!result.rows || !result.recent) {
        bootstrapComplete = true
        break
      }
    }
    if (!bootstrapComplete) nextBackfillPage = Math.max(startPage + 1, lastPage)
  }

  run.cursor = newestSeen
    ? {
        ...cursor,
        sourceKey: UZJOBS_SOURCE.key,
        lastSeenProfileId: webProfileId(newestSeen.url),
        lastSeenUrl: newestSeen.url,
        lastSeenUpdatedAt: newestSeen.activityAt || newestSeen.updatedAt || null,
        backfillPage: nextBackfillPage,
        bootstrapComplete,
        lastSuccessAt: new Date().toISOString(),
      }
    : {
        ...cursor,
        sourceKey: UZJOBS_SOURCE.key,
        backfillPage: nextBackfillPage,
        bootstrapComplete,
        lastSuccessAt: new Date().toISOString(),
      }

  run.profiles = [...byUrl.values()]
  return run
}
