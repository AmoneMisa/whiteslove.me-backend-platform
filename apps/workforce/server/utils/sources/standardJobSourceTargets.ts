import { parseHiringSourceSalary } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { XMLParser } from 'fast-xml-parser'
import {
  crawlStandardJobBoard,
  enrichStandardJobBoardDetails,
} from './cyclicJobBoardCrawler'
import type { Job, JobSource } from '~~/shared/contracts/jobs'
import { detectWorkModes } from '../hiring/hiringLexicon'

const UA = 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)'
const DESC_MAX = Number.POSITIVE_INFINITY

function stripHtml(value: unknown): string {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/json;q=0.9,*/*;q=0.8',
      ...(init?.headers || {}),
    },
  })
  if (!response.ok) {
    let host = 'upstream'
    try { host = new URL(url).host } catch { /* keep generic label */ }
    throw new Error(`${host} -> ${response.status}`)
  }
  return response.text()
}

function slug(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'default'
}

function parseSalary(value: unknown): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency'> {
  const parsed = parseHiringSourceSalary(String(value || ''))
  if (!parsed || (parsed.min == null && parsed.max == null) || !parsed.currency) return {}
  return {
    salaryMin: parsed.min ?? undefined,
    salaryMax: parsed.max ?? undefined,
    salaryCurrency: parsed.currency,
  }
}

// ---------- The Muse ----------
function parseTheMusePage(raw: string): Job[] {
  let data: { results?: any[] }
  try { data = JSON.parse(raw) as { results?: any[] } } catch { return [] }
  return (data.results || []).flatMap((job) => {
    if (!job?.id || !job?.name) return []
    const locations = (job.locations || []).map((location: any) => location.name).filter(Boolean)
    return [{
      id: `themuse-${job.id}`,
      title: job.name,
      company: job.company?.name || 'Unknown',
      location: locations.join(', ') || 'Unknown',
      url: job.refs?.landing_page || '',
      source: 'themuse' as const,
      remote: locations.some((location: string) => detectWorkModes(location).includes('remote')),
      tags: (job.categories || []).map((category: any) => category.name).filter(Boolean).slice(0, 8),
      postedAt: job.publication_date ? new Date(job.publication_date).toISOString() : new Date().toISOString(),
      employmentType: job.type,
      description: stripHtml(job.contents).slice(0, DESC_MAX),
    }]
  })
}

async function fetchTheMuseTarget(): Promise<Job[]> {
  const key = process.env.MUSE_API_KEY
  const run = await crawlStandardJobBoard({
    key: 'source:themuse',
    fetchPage: (page) => {
      const params = new URLSearchParams({ page: String(page - 1), descending: 'true' })
      if (key) params.set('api_key', key)
      return fetchText(`https://www.themuse.com/api/public/jobs?${params}`)
    },
    parsePage: (raw) => parseTheMusePage(raw),
  })
  return run.jobs
}

// ---------- Adzuna ----------
function parseAdzunaPage(raw: string, country: string): Job[] {
  let data: { results?: any[] }
  try { data = JSON.parse(raw) as { results?: any[] } } catch { return [] }
  return (data.results || []).flatMap((job) => {
    if (!job?.id || !job?.title || !job?.redirect_url) return []
    const location = job.location?.display_name || 'Unknown'
    return [{
      id: `adzuna-${job.id}`,
      title: job.title,
      company: job.company?.display_name || 'Unknown',
      location,
      url: job.redirect_url,
      source: 'adzuna' as const,
      remote: detectWorkModes(`${job.title} ${location}`).includes('remote'),
      tags: job.category?.label ? [job.category.label] : [],
      postedAt: job.created ? new Date(job.created).toISOString() : new Date().toISOString(),
      employmentType: job.contract_time,
      salaryMin: job.salary_min ?? undefined,
      salaryMax: job.salary_max ?? undefined,
      salaryCurrency: job.salary_min ? (country.toUpperCase() === 'PL' ? 'PLN' : 'USD') : undefined,
      description: stripHtml(job.description).slice(0, DESC_MAX),
    }]
  })
}

async function fetchAdzunaTarget(country: string): Promise<Job[]> {
  const appId = process.env.ADZUNA_APP_ID
  const appKey = process.env.ADZUNA_APP_KEY
  if (!appId || !appKey) return []

  const run = await crawlStandardJobBoard({
    key: `source:adzuna:${country}`,
    fetchPage: (page) => {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        max_days_old: '14',
        sort_by: 'date',
      })
      return fetchText(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/${page}?${params}`)
    },
    parsePage: (raw) => parseAdzunaPage(raw, country),
  })
  return run.jobs
}

// ---------- Jooble ----------
const JOOBLE_DEFAULT_LOCATIONS = [
  'Uzbekistan',
  'Kazakhstan',
  'Kyrgyzstan',
  'Tajikistan',
  'Turkmenistan',
  'Ukraine',
] as const

function joobleLocations(): string[] {
  const configured = process.env.JOOBLE_LOCATIONS || process.env.JOOBLE_LOCATION
  return (configured ? configured.split(',') : [...JOOBLE_DEFAULT_LOCATIONS])
    .map((location) => location.trim())
    .filter(Boolean)
}

function parseJooblePage(raw: string): Job[] {
  let data: { jobs?: any[] }
  try { data = JSON.parse(raw) as { jobs?: any[] } } catch { return [] }
  return (data.jobs || []).flatMap((job, index) => {
    if (!job?.title || !job?.link) return []
    const description = stripHtml(job.snippet).slice(0, DESC_MAX)
    return [{
      id: `jooble-${job.id || job.link || index}`,
      title: job.title,
      company: job.company || 'Unknown',
      location: job.location || 'Unknown',
      url: job.link,
      source: 'jooble' as const,
      remote: detectWorkModes(`${job.title} ${job.location || ''} ${description}`).includes('remote'),
      tags: [job.type, job.source].filter(Boolean).slice(0, 8),
      postedAt: job.updated ? new Date(job.updated).toISOString() : new Date().toISOString(),
      employmentType: job.type || undefined,
      ...parseSalary(job.salary),
      description,
    }]
  })
}

async function fetchJoobleTarget(location: string): Promise<Job[]> {
  const key = process.env.JOOBLE_KEY
  if (!key) return []
  const keywords = process.env.JOOBLE_KEYWORDS || 'developer'
  const run = await crawlStandardJobBoard({
    key: `source:jooble:${slug(location)}`,
    fetchPage: (page) => fetchText(`https://jooble.org/api/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords,
        location,
        page: String(page),
        companysearch: 'false',
      }),
    }),
    parsePage: (raw) => parseJooblePage(raw),
  })
  return run.jobs
}

// ---------- RSS ----------
const DEFAULT_RSS_FEEDS = [
  'dou.ua|https://jobs.dou.ua/vacancies/feeds/',
  'wwr-support|https://weworkremotely.com/categories/remote-customer-support-jobs.rss',
  'wwr-sales-marketing|https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss',
  'wwr-management-finance|https://weworkremotely.com/categories/remote-management-and-finance-jobs.rss',
  'wwr-other|https://weworkremotely.com/categories/all-other-remote-jobs.rss',
].join(',')

type RssFeed = { key: string; label: string; url: string }

export function configuredRssFeeds(): RssFeed[] {
  const parts: string[] = []
  if (process.env.RSS_DEFAULTS !== 'off') parts.push(DEFAULT_RSS_FEEDS)
  if (process.env.RSS_FEEDS) parts.push(process.env.RSS_FEEDS)
  return parts
    .join(',')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry, index) => {
      const [label = 'rss', url = ''] = entry.split('|')
      if (!url.trim()) return []
      return [{ key: `${slug(label)}-${index}`, label: label.trim() || 'rss', url: url.trim() }]
    })
}

function rssText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return String(record['#text'] || record['@_term'] || record['@_href'] || '')
  }
  return String(value)
}

function isRemoteOnlyRss(url: string): boolean {
  try { return /(^|\.)weworkremotely\.com$/i.test(new URL(url).hostname) } catch { return false }
}

export function parseRssFeed(raw: string, feed: RssFeed): Job[] {
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(raw)
  const rawItems = parsed?.rss?.channel?.item || parsed?.feed?.entry || []
  const items = Array.isArray(rawItems) ? rawItems : [rawItems]
  const remoteOnly = isRemoteOnlyRss(feed.url)
  const out: Job[] = []

  for (const [index, item] of items.entries()) {
    const linkValue = typeof item?.link === 'object'
      ? item.link?.['@_href'] || item.link?.['#text']
      : item?.link
    const link = String(linkValue || '')
    const rawTitle = rssText(item?.title)
    if (!link || !rawTitle) continue
    const description = stripHtml(rssText(item?.description || item?.summary || item?.content)).slice(0, DESC_MAX)
    const region = rssText(item?.region || item?.location || item?.['job:location'])
    const categories = (Array.isArray(item?.category) ? item.category : [item?.category])
      .map(rssText)
      .filter(Boolean)
    let title = rawTitle
    let company = rssText(item?.['dc:creator']) || feed.label
    if (remoteOnly) {
      const separator = rawTitle.indexOf(': ')
      if (separator > 0 && separator < rawTitle.length - 2) {
        company = rawTitle.slice(0, separator).trim()
        title = rawTitle.slice(separator + 2).trim()
      }
    }
    const dateValue = item?.pubDate || item?.published || item?.updated
    out.push({
      id: `rss-${feed.label}-${rssText(item?.guid) || link || index}`,
      title: title || 'Untitled',
      company,
      location: region || (remoteOnly ? 'Remote' : 'See listing'),
      url: link,
      source: 'rss',
      remote: remoteOnly || detectWorkModes(`${rawTitle} ${description} ${region}`).includes('remote'),
      workMode: remoteOnly ? 'remote' : undefined,
      tags: [feed.label, ...categories].slice(0, 8),
      postedAt: dateValue ? new Date(dateValue).toISOString() : new Date().toISOString(),
      description,
    })
  }
  return out
}

async function fetchRssTarget(feed: RssFeed): Promise<Job[]> {
  return parseRssFeed(await fetchText(feed.url), feed)
}

// ---------- ishGO / IT-Jobs.uz ----------
type UzbekBoardSource = 'ishgo' | 'itjobsuz'
type UzbekBoardConfig = {
  source: UzbekBoardSource
  label: string
  listingUrl: string
  detailPrefix: string
  envFlag: 'ISHGO_SOURCE' | 'ITJOBS_UZ_SOURCE'
}

type UzbekBoardLink = { url: string; localizedTitle?: string }

const UZBEK_BOARDS: Record<UzbekBoardSource, UzbekBoardConfig> = {
  ishgo: {
    source: 'ishgo',
    label: 'ishGO.uz',
    listingUrl: 'https://ishgo.uz/ru/vacancies',
    detailPrefix: '/ru/vacancies/',
    envFlag: 'ISHGO_SOURCE',
  },
  itjobsuz: {
    source: 'itjobsuz',
    label: 'IT-Jobs.uz',
    listingUrl: 'https://it-jobs.uz/ru/jobs',
    detailPrefix: '/ru/jobs/',
    envFlag: 'ITJOBS_UZ_SOURCE',
  },
}

function extractUzbekBoardLinks(html: string, config: UzbekBoardConfig): UzbekBoardLink[] {
  const origin = new URL(config.listingUrl).origin
  const links = new Map<string, UzbekBoardLink>()
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(match[1]!.replace(/&amp;/g, '&'), origin)
      if (url.origin !== origin || !url.pathname.startsWith(config.detailPrefix) || url.pathname === config.detailPrefix) continue
      const canonical = `${url.origin}${url.pathname}`
      const heading = match[2]!.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]
      links.set(canonical, { url: canonical, localizedTitle: heading ? stripHtml(heading) : undefined })
    } catch {
      // Ignore malformed unrelated hrefs.
    }
  }
  return [...links.values()]
}

function findJobPosting(value: any): any | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item)
      if (found) return found
    }
    return undefined
  }
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']]
  if (types.includes('JobPosting')) return value
  return findJobPosting(value['@graph'])
}

function extractJobPosting(html: string): any | undefined {
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found = findJobPosting(JSON.parse(match[1]!))
      if (found) return found
    } catch {
      // Keep looking for another JSON-LD block.
    }
  }
  return undefined
}

function schemaSalary(posting: any): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'> {
  const salary = Array.isArray(posting.baseSalary) ? posting.baseSalary[0] : posting.baseSalary
  const value = salary?.value
  const min = Number(value?.minValue ?? value?.value)
  const max = Number(value?.maxValue)
  const unit = String(value?.unitText || '').toLowerCase()
  const salaryPeriod = /hour/.test(unit)
    ? 'hour'
    : /month/.test(unit)
      ? 'month'
      : /year/.test(unit)
        ? 'year'
        : undefined
  return {
    salaryMin: Number.isFinite(min) ? min : undefined,
    salaryMax: Number.isFinite(max) ? max : undefined,
    salaryCurrency: salary?.currency ? String(salary.currency).toUpperCase() : undefined,
    salaryPeriod,
  }
}

function schemaLocation(posting: any): string {
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation]
  const parts = locations
    .map((location: any) => {
      const address = location?.address || {}
      const country = typeof address.addressCountry === 'object'
        ? address.addressCountry.name
        : address.addressCountry
      const unique = new Map<string, string>()
      for (const part of [address.addressLocality, address.addressRegion, country].filter(Boolean)) {
        const text = String(part).trim()
        unique.set(text.toLocaleLowerCase('ru'), text)
      }
      return [...unique.values()].join(', ')
    })
    .filter(Boolean)
  return [...new Set(parts)].join(' / ') || 'Uzbekistan'
}

function normalizeSchemaPosting(
  posting: any,
  summary: Job,
  config: UzbekBoardConfig,
  html: string,
): Job | null {
  if (!posting?.title || !posting?.datePosted) return null
  const date = new Date(posting.datePosted)
  if (Number.isNaN(date.getTime())) return null
  const description = stripHtml(posting.description).slice(0, DESC_MAX)
  const employment = Array.isArray(posting.employmentType)
    ? posting.employmentType.map(String)
    : posting.employmentType
      ? [String(posting.employmentType)]
      : []
  const documentTitle = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])
  const localizedIshGoTitle = config.source === 'ishgo'
    ? documentTitle.match(/^Вакансия\s+(.+?),\s+работа\s+в\b/i)?.[1]
    : undefined
  const sourceTitle = summary.title && summary.title !== config.label ? summary.title : undefined

  return {
    ...summary,
    title: sourceTitle || localizedIshGoTitle || stripHtml(String(posting.title)),
    company: stripHtml(String(posting.hiringOrganization?.name || 'Unknown')),
    location: schemaLocation(posting),
    remote: posting.jobLocationType === 'TELECOMMUTE'
      || /remote|удал[её]н|дистанцион|masofaviy/i.test(`${description} ${employment.join(' ')}`),
    postedAt: date.toISOString(),
    employmentType: employment[0],
    ...schemaSalary(posting),
    description,
  }
}

async function fetchUzbekBoardTarget(source: UzbekBoardSource): Promise<Job[]> {
  const config = UZBEK_BOARDS[source]
  const listing = await fetchText(config.listingUrl)
  const summaries: Job[] = extractUzbekBoardLinks(listing, config).map((link) => ({
    id: `${source}-${new URL(link.url).pathname.split('/').filter(Boolean).pop() || link.url}`,
    title: link.localizedTitle || config.label,
    company: config.label,
    location: 'Uzbekistan',
    url: link.url,
    source,
    remote: false,
    tags: [config.label],
    postedAt: new Date().toISOString(),
  }))

  return enrichStandardJobBoardDetails({
    key: `source:${source}`,
    jobs: summaries,
    fetchDetail: (job) => fetchText(job.url),
    parseDetail: (html, summary) => {
      const posting = extractJobPosting(html)
      return posting ? normalizeSchemaPosting(posting, summary, config, html) : summary
    },
  })
}

// ---------- OLX UZ/KZ ----------
type OlxMarket = { host: string; country: string; countryName: string }
const OLX_MARKETS: OlxMarket[] = [
  { host: 'www.olx.uz', country: 'UZ', countryName: 'Uzbekistan' },
  { host: 'www.olx.kz', country: 'KZ', countryName: 'Kazakhstan' },
]

function parseOlxPage(raw: string, market: OlxMarket): Job[] {
  let data: { data?: any[] }
  try { data = JSON.parse(raw) as { data?: any[] } } catch { return [] }
  return (data.data || [])
    .filter((offer) => offer.status === 'active' || !offer.status)
    .flatMap((offer) => {
      if (!offer?.id || !offer?.title || !offer?.url) return []
      const city = offer.location?.city?.name
      const region = offer.location?.region?.name
      const location = [city, market.countryName].filter(Boolean).join(', ') || market.countryName
      const salary = (offer.params || []).find((param: any) => /salary/i.test(param.key))?.value
      const description = stripHtml(offer.description).slice(0, DESC_MAX)
      return [{
        id: `olx-${market.host}-${offer.id}`,
        title: offer.title,
        company: offer.user?.name || (offer.business ? 'OLX (business)' : 'OLX'),
        location,
        url: offer.url,
        source: 'olx' as const,
        remote: detectWorkModes(`${offer.title} ${description}`).includes('remote'),
        tags: [market.countryName, region].filter(Boolean),
        postedAt: new Date(offer.last_refresh_time || offer.created_time || Date.now()).toISOString(),
        salaryMin: typeof salary?.from === 'number' ? salary.from : undefined,
        salaryMax: typeof salary?.to === 'number' ? salary.to : undefined,
        salaryCurrency: salary?.currency || undefined,
        description,
      }]
    })
}

async function fetchOlxTarget(market: OlxMarket): Promise<Job[]> {
  // OLX's public offers endpoint is offset/limit based. `50` is the endpoint's
  // page size, not a run cap; how many pages are visited is owned by the crawler.
  const pageSize = 50
  const run = await crawlStandardJobBoard({
    key: `source:olx:${market.country.toLowerCase()}`,
    fetchPage: (page) => {
      const params = new URLSearchParams({
        offset: String((page - 1) * pageSize),
        limit: String(pageSize),
        category_id: '6',
        sort_by: 'created_at:desc',
      })
      return fetchText(`https://${market.host}/api/v1/offers/?${params}`)
    },
    parsePage: (raw) => parseOlxPage(raw, market),
  })
  return run.jobs
}

// ---------- target registry ----------
export const STANDARD_JOB_SOURCE_TARGET_PREFIX = 'standard-job-source:'

export function configuredStandardJobSourceTargets(): string[] {
  const targets: string[] = []
  targets.push(`${STANDARD_JOB_SOURCE_TARGET_PREFIX}themuse`)

  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
    targets.push(`${STANDARD_JOB_SOURCE_TARGET_PREFIX}adzuna:${slug(process.env.ADZUNA_COUNTRY || 'pl')}`)
  }
  if (process.env.JOOBLE_KEY) {
    targets.push(...joobleLocations().map((location) => `${STANDARD_JOB_SOURCE_TARGET_PREFIX}jooble:${slug(location)}`))
  }
  if (process.env.RSS_DEFAULTS !== 'off' || process.env.RSS_FEEDS) {
    targets.push(...configuredRssFeeds().map((feed) => `${STANDARD_JOB_SOURCE_TARGET_PREFIX}rss:${feed.key}`))
  }
  if (process.env.ISHGO_SOURCE !== 'off') targets.push(`${STANDARD_JOB_SOURCE_TARGET_PREFIX}ishgo`)
  if (process.env.ITJOBS_UZ_SOURCE !== 'off') targets.push(`${STANDARD_JOB_SOURCE_TARGET_PREFIX}itjobsuz`)
  if (process.env.OLX_SOURCE === 'on') {
    targets.push(...OLX_MARKETS.map((market) => `${STANDARD_JOB_SOURCE_TARGET_PREFIX}olx:${market.country.toLowerCase()}`))
  }
  return targets
}

export function isStandardJobSourceTarget(target: string): boolean {
  return target.startsWith(STANDARD_JOB_SOURCE_TARGET_PREFIX)
}

export function sourceForStandardJobSourceTarget(target: string): JobSource | null {
  if (!isStandardJobSourceTarget(target)) return null
  const key = target.slice(STANDARD_JOB_SOURCE_TARGET_PREFIX.length)
  if (key === 'themuse') return 'themuse'
  if (key.startsWith('adzuna:')) return 'adzuna'
  if (key.startsWith('jooble:')) return 'jooble'
  if (key.startsWith('rss:')) return 'rss'
  if (key === 'ishgo') return 'ishgo'
  if (key === 'itjobsuz') return 'itjobsuz'
  if (key.startsWith('olx:')) return 'olx'
  return null
}

export async function fetchStandardJobSourceTarget(target: string): Promise<{ source: JobSource; jobs: Job[] }> {
  const source = sourceForStandardJobSourceTarget(target)
  if (!source) throw new Error(`Unknown standard job source target ${target}`)
  const key = target.slice(STANDARD_JOB_SOURCE_TARGET_PREFIX.length)

  if (key === 'themuse') return { source, jobs: await fetchTheMuseTarget() }
  if (key.startsWith('adzuna:')) {
    const country = process.env.ADZUNA_COUNTRY || 'pl'
    return { source, jobs: await fetchAdzunaTarget(country) }
  }
  if (key.startsWith('jooble:')) {
    const locationKey = key.slice('jooble:'.length)
    const location = joobleLocations().find((candidate) => slug(candidate) === locationKey)
    if (!location) throw new Error(`Unknown Jooble target ${target}`)
    return { source, jobs: await fetchJoobleTarget(location) }
  }
  if (key.startsWith('rss:')) {
    const feedKey = key.slice('rss:'.length)
    const feed = configuredRssFeeds().find((candidate) => candidate.key === feedKey)
    if (!feed) throw new Error(`Unknown RSS target ${target}`)
    return { source, jobs: await fetchRssTarget(feed) }
  }
  if (key === 'ishgo') return { source, jobs: await fetchUzbekBoardTarget('ishgo') }
  if (key === 'itjobsuz') return { source, jobs: await fetchUzbekBoardTarget('itjobsuz') }
  if (key.startsWith('olx:')) {
    const country = key.slice('olx:'.length).toUpperCase()
    const market = OLX_MARKETS.find((candidate) => candidate.country === country)
    if (!market) throw new Error(`Unknown OLX target ${target}`)
    return { source, jobs: await fetchOlxTarget(market) }
  }
  throw new Error(`Unknown standard job source target ${target}`)
}
