import type { CvProfile } from '../../../shared/contracts/hiring'
import { activityDate, cutoffDate, isRecent } from '../../../shared/hiring/webFields'
import { candidateBlocks, mergeSameCandidate } from './web/common'
import { getWebAdapter } from './web/registry'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 25_000

export interface WebSourceAudit {
  key: string
  label: string
  country: string
  pagesFetched: number
  blocksFound: number
  parsed: number
  rejected: number
  rejectReasons: string[]
  rejectedNoDate: number
  rejectedStale: number
  rejectedShape: number
  rejectSamples: string[]
  fieldCounts: {
    name: number
    age: number
    city: number
    role: number
    salary: number
    activity: number
  }
  withinWindow: number
  deduplicated: number
  fetchDurationMs: number
  newestActivityAt: string | null
  oldestActivityAt: string | null
  httpErrors: string[]
  samples: string[]
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

export async function auditWebSource(key: string, maxPages = 2): Promise<WebSourceAudit> {
  const source = getWebAdapter(key)
  const startedAt = Date.now()
  const audit: WebSourceAudit = {
    key: source.key,
    label: source.label,
    country: source.country,
    pagesFetched: 0,
    blocksFound: 0,
    parsed: 0,
    rejected: 0,
    rejectReasons: [],
    rejectedNoDate: 0,
    rejectedStale: 0,
    rejectedShape: 0,
    rejectSamples: [],
    fieldCounts: { name: 0, age: 0, city: 0, role: 0, salary: 0, activity: 0 },
    withinWindow: 0,
    deduplicated: 0,
    fetchDurationMs: 0,
    newestActivityAt: null,
    oldestActivityAt: null,
    httpErrors: [],
    samples: [],
  }

  const cutoff = cutoffDate().getTime()
  const byUrl = new Map<string, CvProfile>()

  for (let page = 1; page <= maxPages; page += 1) {
    let html: string
    try {
      html = await fetchPage(source.pageUrl(page))
      audit.pagesFetched += 1
    } catch (error) {
      audit.httpErrors.push(`page ${page}: ${(error as Error).message}`)
      break
    }

    const blocks = candidateBlocks(html, source, page)
    audit.blocksFound += blocks.length
    if (!blocks.length) {
      audit.rejectReasons.push(`page ${page}: no candidate blocks in ${html.length} bytes`)
      break
    }

    for (const block of blocks) {
      const profile = source.parse(block, source)
      if (!profile) {
        audit.rejected += 1
        const activity = activityDate(block.text)
        if (!activity) audit.rejectedNoDate += 1
        else if (!isRecent(activity)) audit.rejectedStale += 1
        else audit.rejectedShape += 1
        if (audit.rejectSamples.length < 3) {
          audit.rejectSamples.push(
            `${activity ? (isRecent(activity) ? 'shape' : 'stale ' + activity.slice(0, 10)) : 'no-date'}: `
            + `${block.title.replace(/\n/g, ' | ').slice(0, 90)}`,
          )
        }
        continue
      }

      audit.parsed += 1
      if (profile.name) audit.fieldCounts.name += 1
      if (profile.age != null) audit.fieldCounts.age += 1
      if (profile.city) audit.fieldCounts.city += 1
      if (profile.role) audit.fieldCounts.role += 1
      if (profile.salaryMin != null || profile.salaryMax != null) audit.fieldCounts.salary += 1
      if (profile.activityAt) audit.fieldCounts.activity += 1

      const stamp = Date.parse(profile.activityAt || profile.updatedAt || profile.createdAt || '')
      if (Number.isFinite(stamp)) {
        const iso = new Date(stamp).toISOString()
        if (!audit.newestActivityAt || iso > audit.newestActivityAt) audit.newestActivityAt = iso
        if (!audit.oldestActivityAt || iso < audit.oldestActivityAt) audit.oldestActivityAt = iso
        if (stamp >= cutoff) audit.withinWindow += 1
      }

      const previous = byUrl.get(profile.url)
      byUrl.set(profile.url, previous ? mergeSameCandidate(previous, profile) : profile)
      if (audit.samples.length < 3) {
        audit.samples.push(
          `${(profile.role || profile.name || '(no role)').slice(0, 44)} | ${profile.city || '-'} | `
          + `${profile.activityAt?.slice(0, 10) || '-'} | ${profile.url}`,
        )
      }
    }
  }

  audit.deduplicated = byUrl.size
  if (audit.rejected) audit.rejectReasons.push(`${audit.rejected} blocks the parser could not turn into a profile`)
  audit.fetchDurationMs = Date.now() - startedAt
  return audit
}
