import type { Job } from '~~/shared/contracts/jobs'
import {
  REMOTE_JOB_QUERIES,
  USA_RELOCATION_QUERIES,
  linkedinLocationCoverage,
} from './jobSearchCoverage'
import {
  crawlStandardJobBoard,
  enrichStandardJobBoardDetails,
} from './cyclicJobBoardCrawler'
import { detectWorkModes } from './hiringLexicon'
import { decodeHtmlEntities } from './htmlText'

const LINKEDIN_BASE_URL = 'https://www.linkedin.com'
const LINKEDIN_SEARCH_URL =
  `${LINKEDIN_BASE_URL}/jobs-guest/jobs/api/seeMoreJobPostings/search`
const BASE_LOCATIONS = [
  'Uzbekistan',
  'Ukraine',
  'Kazakhstan',
  'Kyrgyzstan',
  'Georgia',
  'Romania',
  'Moldova',
]
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export type LinkedInSourceHealth = {
  requests: number
  successes: number
  rateLimited: number
  parseFailures: number
  emptyPages: number
  detailRequests: number
  detailSuccesses: number
  closedJobs: number
  lastSuccessAt: string | null
  lastError: string | null
}

const health: LinkedInSourceHealth = {
  requests: 0,
  successes: 0,
  rateLimited: 0,
  parseFailures: 0,
  emptyPages: 0,
  detailRequests: 0,
  detailSuccesses: 0,
  closedJobs: 0,
  lastSuccessAt: null,
  lastError: null,
}

function csvEnv(name: string): string[] {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function boolEnv(name: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(String(process.env[name] || ''))
}

function recordError(error: unknown) {
  health.lastError = error instanceof Error ? error.message : String(error)
}

export function linkedinSourceHealth(): Readonly<LinkedInSourceHealth> {
  return Object.freeze({ ...health })
}

function linkedinText(value: string | undefined): string {
  if (!value) return ''
  return decodeHtmlEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n')
      .replace(/<\/li\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function classText(html: string, tag: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(
    new RegExp(`<${tag}[^>]*class=["'][^"']*${escaped}[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  )
  return linkedinText(match?.[1])
}

function classBlock(html: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(
    new RegExp(`<([a-z0-9]+)[^>]*class=["'][^"']*${escaped}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'),
  )
  return match?.[2] || ''
}

function attributeBlock(html: string, attribute: string, value: string): string {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(
    new RegExp(`<([a-z0-9]+)[^>]*${escapedAttribute}=["'][^"']*${escapedValue}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'),
  )
  return match?.[2] || ''
}

export type LinkedInJobAvailability = 'active' | 'closed' | 'unknown'

export function parseLinkedInJobAvailability(html: string): LinkedInJobAvailability {
  const visibleText = linkedinText(html)
  if (/\b(?:no longer accepting applications|applications? (?:are )?closed)\b/i.test(visibleText)
    || /(?:заявки на эту вакансию больше не принимаются|при[её]м заявок (?:заверш[её]н|закрыт)|вакансия закрыта)/iu.test(visibleText)) {
    return 'closed'
  }
  if (/(?:подать заявку|откликнуться|apply(?: now)?|easy apply)/iu.test(visibleText)) return 'active'
  return 'unknown'
}

function extractJobId(card: string): string | undefined {
  return card.match(/urn:li:jobPosting:(\d+)/i)?.[1]
    || card.match(/\/jobs\/view\/(?:[^"'?/]*-)?(\d+)(?:[/?"'])/i)?.[1]
}

function parseSalaryText(value: string): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency'> {
  const text = linkedinText(value)
  if (!text) return {}
  const currency = /\bUSD\b/i.test(text) || text.includes('$') ? 'USD'
    : /\bEUR\b/i.test(text) || text.includes('€') ? 'EUR'
      : /\bGBP\b/i.test(text) || text.includes('£') ? 'GBP'
        : /\bUAH\b/i.test(text) || text.includes('₴') ? 'UAH'
          : /\bKZT\b/i.test(text) || text.includes('₸') ? 'KZT'
            : text.match(/\b[A-Z]{3}\b/)?.[0]

  const amounts = [...text.matchAll(/(?:^|[^\p{L}\d])([\d][\d\s,.]*)/gu)]
    .map((match) => Number(match[1]!.replace(/[^\d.]/g, '')))
    .filter((amount) => Number.isFinite(amount) && amount > 0)
  if (!amounts.length) return currency ? { salaryCurrency: currency } : {}
  const salaryMin = amounts[0]
  const salaryMax = amounts.length > 1 ? amounts[1] : amounts[0]
  return { salaryMin, salaryMax, ...(currency ? { salaryCurrency: currency } : {}) }
}

export function parseLinkedInJobCards(html: string): Job[] {
  const jobs: Job[] = []
  for (const part of html.split(/<li\b/i).slice(1)) {
    const card = `<li${part}`
    const jobId = extractJobId(card)
    if (!jobId) continue

    const title = classText(card, 'h3', 'base-search-card__title')
    if (!title) continue
    const company = classText(card, 'h4', 'base-search-card__subtitle') || 'Unknown'
    const location = classText(card, 'span', 'job-search-card__location') || 'See listing'
    const salaryText = classText(card, 'span', 'job-search-card__salary-info')
    const datetime = card.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1]
    const posted = datetime && !Number.isNaN(Date.parse(datetime)) ? new Date(datetime) : new Date()

    jobs.push({
      id: `linkedin-${jobId}`,
      title,
      company,
      location,
      url: `${LINKEDIN_BASE_URL}/jobs/view/${jobId}`,
      source: 'linkedin',
      remote: detectWorkModes(`${title} ${location}`).includes('remote'),
      tags: ['LinkedIn'],
      postedAt: posted.toISOString(),
      ...parseSalaryText(salaryText),
    })
  }
  return jobs
}

function criteriaFromDetail(html: string): Map<string, string> {
  const criteria = new Map<string, string>()
  const itemRe = /<li[^>]*class=["'][^"']*description__job-criteria-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
  for (const match of html.matchAll(itemRe)) {
    const item = match[1] || ''
    const label = classText(item, 'h3', 'description__job-criteria-subheader').toLowerCase()
    const value = classText(item, 'span', 'description__job-criteria-text')
    if (label && value) criteria.set(label, value)
  }
  return criteria
}

function directApplyUrl(html: string): string | undefined {
  const code = html.match(/<code\b[^>]*id=["']applyUrl["'][^>]*>([\s\S]*?)<\/code>/i)?.[1]
  if (!code) return undefined
  const decoded = decodeHtmlEntities(linkedinText(code))
  const match = decoded.match(/(?:\?|&)url=([^"'\s&]+)/i)
  if (!match?.[1]) return undefined
  try {
    const url = decodeURIComponent(match[1])
    return /^https?:\/\//i.test(url) ? url : undefined
  } catch {
    return undefined
  }
}

export function parseLinkedInJobDetail(html: string): Partial<Job> {
  const description = linkedinText(
    classBlock(html, 'show-more-less-html__markup')
      || attributeBlock(html, 'data-testid', 'expandable-text-box'),
  )
  const criteria = criteriaFromDetail(html)
  const seniority = criteria.get('seniority level')
  const employmentType = criteria.get('employment type')
  const jobFunction = criteria.get('job function')
  const industries = criteria.get('industries') || criteria.get('industry')
  const salaryText = classText(html, 'div', 'compensation__salary')
    || classText(html, 'span', 'compensation__salary')
  const tags = [seniority, jobFunction, industries].filter((value): value is string => Boolean(value))
  const applyUrl = directApplyUrl(html)
  const availability = parseLinkedInJobAvailability(html)

  return {
    ...(description ? { description: description.slice(0, 20_000) } : {}),
    ...(employmentType ? { employmentType } : {}),
    ...(tags.length ? { tags } : {}),
    ...(applyUrl ? { applyUrl } : {}),
    ...(availability === 'closed' ? { vacancyStatus: 'closed' } : {}),
    ...parseSalaryText(salaryText),
  }
}

type LinkedInSearchFilters = {
  remoteOnly?: boolean
  easyApply?: boolean
  jobTypes?: string[]
  companyIds?: string[]
  distance?: number
}

function configuredFilters(passRemoteOnly = false): LinkedInSearchFilters {
  const distance = Number(process.env.LINKEDIN_DISTANCE)
  return {
    remoteOnly: passRemoteOnly || boolEnv('LINKEDIN_REMOTE_ONLY'),
    easyApply: boolEnv('LINKEDIN_EASY_APPLY'),
    jobTypes: csvEnv('LINKEDIN_JOB_TYPES'),
    companyIds: csvEnv('LINKEDIN_COMPANY_IDS'),
    distance: Number.isFinite(distance) && distance >= 0 ? distance : undefined,
  }
}

export function buildLinkedInSearchParams(
  location: string,
  keywords: string,
  start: number,
  filters: LinkedInSearchFilters = {},
): URLSearchParams {
  const params = new URLSearchParams({
    location,
    start: String(start),
    pageNum: '0',
    sortBy: 'DD',
    // Site-wide vacancy retention is 14 days; ask LinkedIn for the same window.
    f_TPR: `r${14 * 24 * 60 * 60}`,
  })
  if (keywords) params.set('keywords', keywords)
  if (filters.distance !== undefined) params.set('distance', String(filters.distance))
  if (filters.remoteOnly) params.set('f_WT', '2')
  if (filters.easyApply) params.set('f_AL', 'true')
  if (filters.jobTypes?.length) params.set('f_JT', filters.jobTypes.join(','))
  if (filters.companyIds?.length) params.set('f_C', filters.companyIds.join(','))
  return params
}

async function linkedinFetch(url: string): Promise<Response> {
  health.requests += 1
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    })
    if (response.status === 429) health.rateLimited += 1
    if (response.ok) {
      health.successes += 1
      health.lastSuccessAt = new Date().toISOString()
    } else {
      health.lastError = `HTTP ${response.status} for ${new URL(url).pathname}`
    }
    return response
  } catch (error) {
    recordError(error)
    throw error
  }
}

type SearchPass = {
  location: string
  keywords: string
  tags?: string[]
  forceRemote?: boolean
  remoteOnly?: boolean
}

function configuredLocations(): string[] {
  const configured = process.env.LINKEDIN_LOCATIONS
  if (configured) {
    const values = configured.split(',').map((value) => value.trim()).filter(Boolean)
    if (values.length) return values
  }
  return [...new Set([
    ...BASE_LOCATIONS,
    ...linkedinLocationCoverage().map((place) => place.location),
  ])]
}

function configuredPasses(): SearchPass[] {
  const baseQuery = String(process.env.LINKEDIN_QUERY || '').trim()
  const standard = configuredLocations().map((location) => ({ location, keywords: baseQuery }))
  const countryRemote: SearchPass[] = [
    { location: 'Uzbekistan', keywords: baseQuery, tags: ['Remote Uzbekistan'], forceRemote: true, remoteOnly: true },
    { location: 'Kazakhstan', keywords: baseQuery, tags: ['Remote Kazakhstan'], forceRemote: true, remoteOnly: true },
    { location: 'Ukraine', keywords: baseQuery, tags: ['Remote Ukraine'], forceRemote: true, remoteOnly: true },
    { location: 'Romania', keywords: baseQuery, tags: ['Remote Romania'], forceRemote: true, remoteOnly: true },
  ]
  const remote = REMOTE_JOB_QUERIES.map((keywords) => ({
    location: 'Worldwide',
    keywords: baseQuery ? `${baseQuery} ${keywords}` : keywords,
    tags: ['Remote search', 'Worldwide remote'],
    forceRemote: true,
    remoteOnly: true,
  }))
  const relocation = USA_RELOCATION_QUERIES.map((keywords) => ({
    location: 'United States',
    keywords: baseQuery ? `${baseQuery} ${keywords}` : keywords,
    tags: ['USA relocation search', 'Visa/relocation search'],
  }))
  return [...standard, ...countryRemote, ...remote, ...relocation]
}

function stableToken(value: string): string {
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(36)
}

function passKey(pass: SearchPass): string {
  return `${pass.location.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${stableToken(JSON.stringify(pass))}`
}

async function fetchSearchPage(pass: SearchPass, page: number): Promise<string> {
  // LinkedIn's guest endpoint advances by 25 postings and rejects offsets at
  // 1000+. That is the upstream pagination contract; traversal is crawler-owned.
  const start = (page - 1) * 25
  if (start >= 1_000) return ''
  const params = buildLinkedInSearchParams(pass.location, pass.keywords, start, configuredFilters(pass.remoteOnly))
  const response = await linkedinFetch(`${LINKEDIN_SEARCH_URL}?${params}`)
  if (!response.ok) throw new Error(`LinkedIn ${pass.location} start=${start} -> ${response.status}`)
  return response.text()
}

function parseSearchPage(html: string, pass: SearchPass): Job[] {
  const jobs = parseLinkedInJobCards(html)
  if (!jobs.length) health.emptyPages += 1
  return jobs.map((job) => ({
    ...job,
    remote: pass.forceRemote === true || job.remote,
    tags: [...new Set([...(job.tags || []), ...(pass.tags || [])])],
  }))
}

async function fetchDetail(job: Job): Promise<string> {
  const jobId = job.id.replace(/^linkedin-/, '')
  if (!/^\d+$/.test(jobId)) return ''
  health.detailRequests += 1
  const response = await linkedinFetch(`${LINKEDIN_BASE_URL}/jobs/view/${jobId}`)
  if (!response.ok || /linkedin\.com\/signup/i.test(response.url)) {
    throw new Error(`LinkedIn detail ${jobId} -> ${response.status}`)
  }
  health.detailSuccesses += 1
  return response.text()
}

function mergeDetail(html: string, summary: Job): Job {
  if (!html) return summary
  try {
    const detail = parseLinkedInJobDetail(html)
    if (detail.vacancyStatus === 'closed') health.closedJobs += 1
    return {
      ...summary,
      ...detail,
      tags: [...new Set([...(summary.tags || []), ...(detail.tags || [])])],
      remote: summary.remote
        || detectWorkModes(`${summary.title} ${summary.location} ${detail.description || ''}`).includes('remote'),
    }
  } catch (error) {
    health.parseFailures += 1
    recordError(error)
    return summary
  }
}

export const LINKEDIN_JOB_TARGET_PREFIX = 'linkedin-job-search:'

export function configuredLinkedInJobTargets(): string[] {
  if (process.env.LINKEDIN_SOURCE === 'off') return []
  return configuredPasses().map((pass) => `${LINKEDIN_JOB_TARGET_PREFIX}${passKey(pass)}`)
}

export function isLinkedInJobTarget(target: string): boolean {
  return target.startsWith(LINKEDIN_JOB_TARGET_PREFIX)
}

export async function fetchLinkedInJobTarget(target: string): Promise<Job[]> {
  if (!isLinkedInJobTarget(target)) throw new Error(`Unknown LinkedIn job target ${target}`)
  const key = target.slice(LINKEDIN_JOB_TARGET_PREFIX.length)
  const pass = configuredPasses().find((candidate) => passKey(candidate) === key)
  if (!pass) throw new Error(`Unknown LinkedIn job target ${target}`)

  const run = await crawlStandardJobBoard({
    key: `linkedin:${key}`,
    fetchPage: (page) => fetchSearchPage(pass, page),
    parsePage: (html) => parseSearchPage(html, pass),
  })
  return enrichStandardJobBoardDetails({
    key: `linkedin:${key}`,
    jobs: run.jobs,
    fetchDetail,
    parseDetail: mergeDetail,
  })
}
