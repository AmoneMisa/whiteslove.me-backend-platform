import { XMLParser } from 'fast-xml-parser'
import { parseHiringActivityDate } from '@whiteslove/parsing-lexicon/hiring-temporal'
import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'
import { extractSalaryFromText } from '../vacancies/domain/enrich'
import { detectLexiconCity, detectWorkModes } from './hiringLexicon'
import type { Job } from '~~/shared/contracts/jobs'

const MAX_DESCRIPTION = 2_400
const MAX_AGE_MS = 14 * 86_400_000
const USER_AGENT = 'jobFinder/1.0 (vacancy search; contact: admin@whiteslove.me)'

/**
 * DOU owns these category names. Keeping the complete source taxonomy here is
 * ingestion configuration, not a second profession lexicon: semantic matching
 * of a user query still belongs to parsing-lexicon + Elasticsearch.
 */
export const DOU_CATEGORIES = [
  '.NET',
  'Account Manager',
  'AI/ML',
  'Analyst',
  'Android',
  'Animator',
  'Architect',
  'Artist',
  'Assistant',
  'Big Data',
  'Blockchain',
  'C++',
  'C-level',
  'Copywriter',
  'Data Engineer',
  'Data Science',
  'DBA',
  'Design',
  'DevOps',
  'Embedded',
  'Engineering Manager',
  'Erlang',
  'ERP/CRM',
  'Finance',
  'Flutter',
  'Front End',
  'Golang',
  'Hardware',
  'HR',
  'iOS/macOS',
  'Java',
  'Legal',
  'Marketing',
  'No-code',
  'Node.js',
  'Office Manager',
  'Other',
  'PHP',
  'Procurement',
  'Product Manager',
  'Project Manager',
  'Python',
  'QA',
  'React Native',
  'Ruby',
  'Rust',
  'Sales',
  'Salesforce',
  'SAP',
  'Scala',
  'Scrum Master',
  'Security',
  'SEO',
  'Support',
  'SysAdmin',
  'Technical Writer',
  'Unity',
  'Unreal Engine',
  'Військова справа',
] as const

const WORK_UA_FALLBACK_SEARCHES = [
  'IT',
  'адміністрація',
  'будівництво',
  'бухгалтерія',
  'готельно ресторанний бізнес',
  'дизайн',
  'змі',
  'краса фітнес спорт',
  'культура',
  'логістика',
  'маркетинг',
  'медицина фармацевтика',
  'нерухомість',
  'освіта',
  'охорона безпека',
  'продаж закупівля',
  'виробництво',
  'роздрібна торгівля',
  'секретаріат',
  'сільське господарство',
  'страхування',
  'сфера обслуговування',
  'телекомунікації',
  'топменеджмент',
  'транспорт',
  'HR',
  'фінанси банк',
  'юриспруденція',
]

const ROBOTA_UA_FALLBACK_SEARCHES = [
  'vyrobnytstvo',
  'avtobiznes',
  'administratyvnyy-personal',
  'it',
  'budivnytstvo',
  'bukhhalteriya',
  'zakupivli',
  'hr',
  'dizayn',
  'banky',
  'hoteli',
  'lohistyka',
  'marketynh',
  'medytsyna',
  'prodazhi',
  'rozdribna-torhivlya',
  'transport',
  'finansy',
  'yurysprudentsiya',
]

type PublicBoardStream = {
  key: string
  label: string
  baseUrl: string
}

type CrawlBoardStream = {
  key: string
  label: string
  pageUrl: (page: number) => string
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
}

function stripHtml(value: unknown): string {
  return decodeEntities(String(value || ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanStreamLabel(value: unknown): string {
  return stripHtml(value)
    .replace(/[\s\u00a0]+\d[\d\s\u00a0]*$/u, '')
    .trim()
    .slice(0, 120)
}

function rssText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return String(record['#text'] || record['@_term'] || record['@_href'] || '')
  }
  return String(value)
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.7',
      'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.7',
      'User-Agent': USER_AGENT,
    },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

function sourceTerms(value: string | undefined, defaults: readonly string[]): string[] {
  const raw = String(value || '').trim()
  return (raw ? raw.split(',') : [...defaults])
    .map((item) => item.trim())
    .filter(Boolean)
}

function canonicalUrl(raw: string, base: string): string {
  try {
    const url = new URL(raw, base)
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function sourceLocation(text: string): { location: string; city?: string; remote: boolean } {
  const city = detectLexiconCity(text, 'UA') || undefined
  const remote = detectWorkModes(text).includes('remote')
  return {
    location: city ? `${city}, Ukraine` : remote ? 'Remote, Ukraine' : 'Ukraine',
    city,
    remote,
  }
}

function recentPostedAt(text: string, fallback = new Date()): string | null {
  const parsed = parseHiringActivityDate(text)
  if (!parsed) return fallback.toISOString()
  const time = Date.parse(parsed)
  if (!Number.isFinite(time)) return fallback.toISOString()
  if (time < fallback.getTime() - MAX_AGE_MS || time > fallback.getTime() + 48 * 60 * 60 * 1000) return null
  return new Date(time).toISOString()
}

function streamKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'default'
}

function parseRssXml(xml: string, url: string, tag: string, idPrefix: string): Job[] {
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml)
  const rawItems = parsed?.rss?.channel?.item || parsed?.feed?.entry || []
  const items = Array.isArray(rawItems) ? rawItems : [rawItems]
  const out: Job[] = []

  for (const [index, item] of items.entries()) {
    const linkValue = typeof item?.link === 'object'
      ? item.link?.['@_href'] || item.link?.['#text']
      : item?.link
    const link = canonicalUrl(String(linkValue || ''), url)
    const rawTitle = stripHtml(rssText(item?.title))
    if (!link || !rawTitle) continue

    const description = stripHtml(rssText(item?.description || item?.summary || item?.content)).slice(0, MAX_DESCRIPTION)
    const company = stripHtml(rssText(item?.['dc:creator'] || item?.author?.name || item?.author)) || `${tag} employer`
    const region = stripHtml(rssText(item?.region || item?.location || item?.['job:location']))
    const context = `${rawTitle} ${region} ${description}`
    const location = sourceLocation(context)
    const dateValue = item?.pubDate || item?.published || item?.updated
    const posted = dateValue ? new Date(dateValue) : new Date()
    const postedAt = Number.isNaN(posted.getTime()) ? new Date().toISOString() : posted.toISOString()
    if (Date.parse(postedAt) < Date.now() - MAX_AGE_MS) continue

    out.push({
      id: `${idPrefix}-${rssText(item?.guid) || link || index}`,
      title: rawTitle,
      company,
      location: location.location,
      city: location.city,
      country: 'UA',
      url: link,
      applyUrl: link,
      source: 'companies',
      remote: location.remote,
      tags: [tag],
      postedAt,
      description: description || undefined,
      employerType: 'board',
      ...extractSalaryFromText(description),
    })
  }

  return out
}

function searchCardRanges(html: string, pattern: RegExp): Array<{ href: string; id: string; inner: string; index: number }> {
  const out: Array<{ href: string; id: string; inner: string; index: number }> = []
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html))) {
    out.push({ href: match[1]!, id: match[2]!, inner: match[3]!, index: match.index })
  }
  return out
}

function headingOrAnchor(inner: string): string {
  const heading = inner.match(/<(?:h1|h2|h3|h4)\b[^>]*>([\s\S]*?)<\/(?:h1|h2|h3|h4)>/i)?.[1]
  const title = stripHtml(heading || inner)
  return title.length <= 220 ? title : ''
}

export function parseDjinniPage(html: string, now = new Date()): Job[] {
  const matches = searchCardRanges(
    html,
    /<a\b[^>]*href=["']((?:https?:\/\/(?:www\.)?djinni\.co)?\/jobs\/(\d+)-[^"']*\/?)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )
  const jobs: Job[] = []
  const seen = new Set<string>()

  for (const [index, match] of matches.entries()) {
    if (seen.has(match.id)) continue
    const title = headingOrAnchor(match.inner)
    if (!title || /^more$/i.test(title)) continue

    const end = matches.slice(index + 1).find((candidate) => candidate.id !== match.id)?.index
      ?? Math.min(html.length, match.index + 12_000)
    const text = stripHtml(html.slice(match.index, end)).slice(0, MAX_DESCRIPTION)
    const postedAt = recentPostedAt(text, now)
    if (!postedAt) continue
    const location = sourceLocation(text)
    const url = canonicalUrl(match.href, 'https://djinni.co')
    if (!url) continue

    seen.add(match.id)
    jobs.push({
      id: `companies-djinni-${match.id}`,
      title,
      company: 'Djinni employer',
      location: location.location,
      city: location.city,
      country: 'UA',
      url,
      applyUrl: url,
      source: 'companies',
      remote: location.remote,
      tags: ['Djinni'],
      postedAt,
      description: text || undefined,
      employerType: 'board',
      ...extractSalaryFromText(text),
    })
  }

  return jobs
}

export function parseWorkUaPage(html: string, stream: string, now = new Date()): Job[] {
  const matches = searchCardRanges(
    html,
    /<a\b[^>]*href=["'](\/jobs\/(\d+)\/?(?:[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )
  const jobs: Job[] = []
  const seen = new Set<string>()

  for (const [index, match] of matches.entries()) {
    if (seen.has(match.id)) continue
    const title = headingOrAnchor(match.inner)
    if (!title || /^(?:відгукнути|apply|зберегти|подати)/iu.test(title)) continue

    const end = matches.slice(index + 1).find((candidate) => candidate.id !== match.id)?.index
      ?? Math.min(html.length, match.index + 8_000)
    const text = stripHtml(html.slice(match.index, end)).slice(0, MAX_DESCRIPTION)
    const postedAt = recentPostedAt(text, now)
    if (!postedAt) continue
    const location = sourceLocation(text)
    const url = canonicalUrl(match.href, 'https://www.work.ua')
    if (!url) continue

    seen.add(match.id)
    jobs.push({
      id: `companies-workua-${match.id}`,
      title,
      company: 'Work.ua employer',
      location: location.location,
      city: location.city,
      country: 'UA',
      url,
      applyUrl: url,
      source: 'companies',
      remote: location.remote,
      tags: ['Work.ua', stream],
      postedAt,
      description: text || undefined,
      employerType: 'board',
      ...extractSalaryFromText(text),
    })
  }

  return jobs
}

export function parseRobotaUaPage(html: string, stream: string, now = new Date()): Job[] {
  const matches = searchCardRanges(
    html,
    /<a\b[^>]*href=["']((?:https?:\/\/(?:www\.)?robota\.ua)?\/company\d+\/vacancy(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )
  const jobs: Job[] = []
  const seen = new Set<string>()

  for (const [index, match] of matches.entries()) {
    if (seen.has(match.id)) continue
    const title = headingOrAnchor(match.inner)
    if (!title) continue

    const end = matches.slice(index + 1).find((candidate) => candidate.id !== match.id)?.index
      ?? Math.min(html.length, match.index + 10_000)
    const text = stripHtml(html.slice(match.index, end)).slice(0, MAX_DESCRIPTION)
    const postedAt = recentPostedAt(text, now)
    if (!postedAt) continue
    const location = sourceLocation(text)
    const url = canonicalUrl(match.href, 'https://robota.ua')
    if (!url) continue

    seen.add(match.id)
    jobs.push({
      id: `companies-robotaua-${match.id}`,
      title,
      company: 'Robota.ua employer',
      location: location.location,
      city: location.city,
      country: 'UA',
      url,
      applyUrl: url,
      source: 'companies',
      remote: location.remote,
      tags: ['Robota.ua', stream],
      postedAt,
      description: text || undefined,
      employerType: 'board',
      ...extractSalaryFromText(text),
    })
  }

  return jobs
}

function section(html: string, startPattern: RegExp, endPattern: RegExp): string {
  const startMatch = startPattern.exec(html)
  if (!startMatch || startMatch.index == null) return html
  const start = startMatch.index
  const rest = html.slice(start + startMatch[0].length)
  const endMatch = endPattern.exec(rest)
  return endMatch && endMatch.index != null ? html.slice(start, start + startMatch[0].length + endMatch.index) : html.slice(start)
}

export function parseWorkUaCategoryIndex(html: string): PublicBoardStream[] {
  const scope = section(html, /(?:Пошук\s+вакансій\s+за\s+категоріями|Вакансії\s+за\s+категоріями)/iu, /Вакансії\s+за\s+містами/iu)
  const pattern = /<a\b[^>]*href=["'](\/jobs-([^"'?#/]+)\/?)["'][^>]*>([\s\S]*?)<\/a>/gi
  const streams = new Map<string, PublicBoardStream>()
  let match: RegExpExecArray | null

  while ((match = pattern.exec(scope))) {
    const key = streamKey(match[2] || '')
    const label = cleanStreamLabel(match[3]) || match[2] || key
    if (!key || streams.has(key)) continue
    const path = String(match[1]).endsWith('/') ? String(match[1]) : `${match[1]}/`
    streams.set(key, { key, label, baseUrl: `https://www.work.ua${path}` })
  }

  return [...streams.values()]
}

export function parseRobotaUaProfessionalStreams(html: string): PublicBoardStream[] {
  const scope = section(html, /Професійні\s+сфери/iu, /Популярні\s+професії/iu)
  const pattern = /<a\b[^>]*href=["'](?:https?:\/\/(?:www\.)?robota\.ua)?\/zapros\/([^/?#"']+)(?:\/ukraine)?[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
  const streams = new Map<string, PublicBoardStream>()
  let match: RegExpExecArray | null

  while ((match = pattern.exec(scope))) {
    const rawSlug = String(match[1] || '').trim()
    const key = streamKey(rawSlug)
    const label = cleanStreamLabel(match[2]) || rawSlug
    if (!key || !rawSlug || streams.has(key)) continue
    streams.set(key, {
      key,
      label,
      baseUrl: `https://robota.ua/zapros/${rawSlug}/ukraine`,
    })
  }

  return [...streams.values()]
}

function workUaSearchStream(term: string): CrawlBoardStream {
  return {
    key: `search:${streamKey(term)}`,
    label: term,
    pageUrl: (page) => {
      const url = new URL('https://www.work.ua/jobs/')
      url.searchParams.set('search', term)
      url.searchParams.set('days', '14')
      url.searchParams.set('sort', 'publication')
      if (page > 1) url.searchParams.set('page', String(page))
      return url.toString()
    },
  }
}

function robotaUaSearchStream(slug: string): CrawlBoardStream {
  const key = streamKey(slug)
  const baseUrl = `https://robota.ua/zapros/${encodeURIComponent(slug)}/ukraine`
  return {
    key: `search:${key}`,
    label: slug,
    pageUrl: (page) => page > 1 ? `${baseUrl}?page=${page}` : baseUrl,
  }
}

export const UKRAINE_JOB_TARGET_PREFIX = 'ukraine-job-source:'

function douCategories(): string[] {
  return sourceTerms(process.env.DOU_JOB_CATEGORIES, DOU_CATEGORIES)
}

function workUaStreams(): CrawlBoardStream[] {
  return sourceTerms(process.env.WORK_UA_SEARCH_STREAMS, WORK_UA_FALLBACK_SEARCHES).map(workUaSearchStream)
}

function robotaUaStreams(): CrawlBoardStream[] {
  return sourceTerms(process.env.ROBOTA_UA_SEARCH_STREAMS, ROBOTA_UA_FALLBACK_SEARCHES).map(robotaUaSearchStream)
}

export function configuredUkraineJobTargets(): string[] {
  const targets: string[] = []
  if (String(process.env.DOU_SOURCE || 'on').toLowerCase() !== 'off') {
    targets.push(...douCategories().map((category) => `${UKRAINE_JOB_TARGET_PREFIX}dou-${streamKey(category)}`))
  }
  if (String(process.env.DJINNI_SOURCE || 'on').toLowerCase() !== 'off') {
    targets.push(`${UKRAINE_JOB_TARGET_PREFIX}djinni-rss`, `${UKRAINE_JOB_TARGET_PREFIX}djinni-board`)
  }
  if (String(process.env.WORK_UA_SOURCE || 'on').toLowerCase() !== 'off') {
    targets.push(...workUaStreams().map((stream) => `${UKRAINE_JOB_TARGET_PREFIX}work-ua-${streamKey(stream.label)}`))
  }
  if (String(process.env.ROBOTA_UA_SOURCE || 'on').toLowerCase() !== 'off') {
    targets.push(...robotaUaStreams().map((stream) => `${UKRAINE_JOB_TARGET_PREFIX}robota-ua-${streamKey(stream.label)}`))
  }
  return [...new Set(targets)]
}

export function isUkraineJobTarget(target: string): boolean {
  return target.startsWith(UKRAINE_JOB_TARGET_PREFIX)
}

async function fetchDouTarget(key: string): Promise<Job[]> {
  const category = douCategories().find((item) => streamKey(item) === key)
  if (!category) throw new Error(`Unknown DOU category ${key}`)
  const params = new URLSearchParams({ category })
  const url = `https://jobs.dou.ua/vacancies/feeds/?${params.toString()}`
  return parseRssXml(await fetchText(url), url, `DOU · ${category}`, `companies-dou-${streamKey(category)}`)
}

async function fetchDjinniBoardTarget(): Promise<Job[]> {
  const run = await crawlStandardJobBoard({
    key: 'ukraine:djinni',
    fetchPage: (page) => fetchText(page === 1 ? 'https://djinni.co/jobs/' : `https://djinni.co/jobs/?page=${page}`),
    parsePage: (html) => parseDjinniPage(html),
  })
  return run.jobs
}

async function fetchWorkUaTarget(key: string): Promise<Job[]> {
  const stream = workUaStreams().find((item) => streamKey(item.label) === key)
  if (!stream) throw new Error(`Unknown Work.ua stream ${key}`)
  const run = await crawlStandardJobBoard({
    key: `ukraine:work-ua:${stream.key}`,
    fetchPage: (page) => fetchText(stream.pageUrl(page)),
    parsePage: (html) => parseWorkUaPage(html, stream.label),
  })
  return run.jobs
}

async function fetchRobotaUaTarget(key: string): Promise<Job[]> {
  const stream = robotaUaStreams().find((item) => streamKey(item.label) === key)
  if (!stream) throw new Error(`Unknown Robota.ua stream ${key}`)
  const run = await crawlStandardJobBoard({
    key: `ukraine:robota-ua:${stream.key}`,
    fetchPage: (page) => fetchText(stream.pageUrl(page)),
    parsePage: (html) => parseRobotaUaPage(html, stream.label),
  })
  return run.jobs
}

export async function fetchUkraineJobTarget(target: string): Promise<Job[]> {
  if (!isUkraineJobTarget(target)) throw new Error(`Unknown Ukraine job target ${target}`)
  const key = target.slice(UKRAINE_JOB_TARGET_PREFIX.length)
  if (key.startsWith('dou-')) return fetchDouTarget(key.slice('dou-'.length))
  if (key === 'djinni-rss') {
    const url = process.env.DJINNI_RSS_URL || 'https://djinni.co/jobs/rss/'
    return parseRssXml(await fetchText(url), url, 'Djinni', 'companies-djinni-rss')
  }
  if (key === 'djinni-board') return fetchDjinniBoardTarget()
  if (key.startsWith('work-ua-')) return fetchWorkUaTarget(key.slice('work-ua-'.length))
  if (key.startsWith('robota-ua-')) return fetchRobotaUaTarget(key.slice('robota-ua-'.length))
  throw new Error(`Unknown Ukraine job target ${target}`)
}
