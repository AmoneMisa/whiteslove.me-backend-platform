import { detectCandidateRemotePreference } from '@whiteslove/parsing-lexicon/hiring-semantics'
import { parseHiringActivityDate } from '@whiteslove/parsing-lexicon/hiring-temporal'
import { normalizeCandidate } from './hiringNormalize'
import type { CvProfile } from '~~/shared/contracts/hiring'
import { absoluteUrl, cityFrom, contacts, employment, htmlText, isRecent, parseSalary } from './hiringWebFields'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 25_000
const MAX_PAGES = 3

interface CandidateBlock {
  href: string
  title: string
  text: string
  html: string
}

function blockAnchors(html: string): CandidateBlock[] {
  const root = 'https://flagma.uz/ru/resume/'
  const matches: Array<{ index: number; end: number; href: string; title: string }> = []
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const href = absoluteUrl(match[1]!, root)
    if (!/flagma\.uz\/(?:ru\/)?(?:rezyume|resume)-[^?#]*-rr\d+\.html/i.test(href)) continue
    const title = htmlText(match[2]!)
    if (!title || title.length > 240) continue
    matches.push({ index: match.index, end: re.lastIndex, href, title })
  }

  const grouped: Array<{ href: string; first: number; end: number; titles: string[] }> = []
  for (const item of matches) {
    const current = grouped[grouped.length - 1]
    if (current && current.href === item.href) {
      current.end = Math.max(current.end, item.end)
      current.titles.push(item.title)
      continue
    }
    grouped.push({ href: item.href, first: item.index, end: item.end, titles: [item.title] })
  }

  return grouped.map((item, index) => {
    const start = Math.max(0, item.first - 350)
    const end = grouped[index + 1]?.first ?? Math.min(html.length, item.end + 5_000)
    const sliced = html.slice(start, end)
    const cut = start > 0 ? sliced.indexOf('>') : -1
    const trimmed = cut >= 0 && cut < 400 ? sliced.slice(cut + 1) : sliced
    const orphan = trimmed.search(/<\/(?:script|style)>/i)
    const opens = trimmed.search(/<(?:script|style)\b/i)
    const raw = orphan >= 0 && (opens < 0 || orphan < opens)
      ? trimmed.slice(trimmed.indexOf('>', orphan) + 1)
      : trimmed
    const title = item.titles.reduce((longest, candidate) => candidate.length > longest.length ? candidate : longest, '')
    return { href: item.href, title, html: raw, text: htmlText(raw) }
  })
}

const DEMOGRAPHICS_RE =
  /^\s*([^,|\n\d][^,|\n]{1,80})?\s*,?\s*(\d{2})\s*(?:года|лет|год|yil)\s*,\s*([^,|\n]{2,80}?)\s*(?:,\s*([A-Z]{2})\b)?\s*(?:\||$)/mu

function profileId(url: string): string {
  const token = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(-180)
  return `web-flagma-uz-${token}`
}

function parseBlock(block: CandidateBlock): CvProfile | null {
  const activity = parseHiringActivityDate(block.text)
  if (!isRecent(activity)) return null

  const lines = block.text.split('\n').map((line) => line.trim()).filter(Boolean)
  const demographicsIndex = lines.findIndex((line) => DEMOGRAPHICS_RE.test(line))
  const demographics = demographicsIndex >= 0 ? lines[demographicsIndex]!.match(DEMOGRAPHICS_RE) : null
  const age = demographics ? Number(demographics[2]) : null
  const inlineName = demographics?.[1]?.replace(/[,|]+$/, '').trim() || ''
  const rowAbove = demographicsIndex > 0 ? lines[demographicsIndex - 1]!.replace(/[,|]+$/, '').trim() : ''
  const nameCandidate = inlineName || rowAbove
  const name = nameCandidate && nameCandidate.length <= 100 && !/^\d|€|\$|₸|сум|сохранить/iu.test(nameCandidate)
    ? nameCandidate
    : ''
  const city = demographics?.[3]?.trim() || null
  const candidateCountry = demographics?.[4]?.toUpperCase() || 'UZ'
  const publicContacts = contacts(block.text)
  const hasDirect = Boolean(publicContacts.phone || publicContacts.email || publicContacts.telegram)

  return normalizeCandidate({
    id: profileId(block.href),
    source: 'telegram',
    origin: 'web',
    sourceKey: 'flagma-uz',
    sourceCountry: 'UZ',
    country: candidateCountry,
    name,
    role: block.title,
    age: age != null && age >= 14 && age <= 90 ? age : null,
    isAdult: age == null ? true : age >= 18,
    city,
    remote: detectCandidateRemotePreference(block.text) ?? false,
    employmentTypes: employment(block.text),
    url: block.href,
    publishedAt: activity,
    updatedAt: activity,
    activityAt: activity,
    createdAt: activity,
    originalText: block.text.slice(0, 4_000),
    description: block.text.slice(0, 4_000),
    tags: ['Flagma UZ', 'Web CV', 'UZ'],
    contacts: publicContacts,
    contact: publicContacts.telegram || publicContacts.email || publicContacts.phone || block.href,
    contactType: hasDirect ? 'direct' : 'platform',
    ...parseSalary(block.text, 'UZ'),
  })
}

function flagmaRegion(city: string): string {
  return cityFrom(city, 'UZ') === 'Tashkent' ? 'tashkent/' : ''
}

function pageUrl(term: string, page: number, city: string): string {
  const querySegment = encodeURIComponent(`q=${term.trim().replace(/\s+/g, ' ')}`)
  const suffix = page <= 1 ? '' : `page-${page}/`
  return `https://flagma.uz/ru/resume/${flagmaRegion(city)}${querySegment}/${suffix}`
}

/**
 * Query-specific Flagma search complements the bounded background crawl.
 * Flagma UZ has enough CV volume that a small global feed window cannot
 * represent a role search. Tashkent queries use Flagma's own city scope; other
 * cities safely fall back to the country-wide search and are filtered later.
 */
export async function searchTargetedHiringProfiles(term: string, city = ''): Promise<CvProfile[]> {
  const normalized = term.trim().replace(/\s+/g, ' ')
  if (normalized.length < 2 || normalized.length > 120) return []

  const byUrl = new Map<string, CvProfile>()
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetch(pageUrl(normalized, page, city), {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru,en;q=0.8',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`flagma.uz targeted search -> ${response.status}`)
    const html = await response.text()
    const blocks = blockAnchors(html)
    if (!blocks.length) break

    let recentOnPage = 0
    for (const block of blocks) {
      const profile = parseBlock(block)
      if (!profile) continue
      recentOnPage += 1
      byUrl.set(profile.url, profile)
    }
    if (!recentOnPage) break
  }
  return [...byUrl.values()]
}
