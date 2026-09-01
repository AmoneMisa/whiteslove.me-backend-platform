import { detectCityFromText, detectCountryCodeFromText } from '@whiteslove/parsing-lexicon/geography-detection'
import type { Job } from '~~/shared/contracts/jobs'
import { detectWorkModes } from './hiringLexicon'
import { absoluteHttpUrl as absoluteUrl, htmlLines, stripHtml } from './htmlText'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MAX_AGE_DAYS = 14
const MAX_DESCRIPTION = 4_000

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en,ru,ro;q=0.8',
    },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

function recent(iso: string): boolean {
  const time = Date.parse(iso)
  return Number.isFinite(time)
    && time >= Date.now() - MAX_AGE_DAYS * 86_400_000
    && time <= Date.now() + 48 * 60 * 60 * 1000
}

function dateFromUrl(url: string): string | null {
  const match = new URL(url).pathname.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//)
  if (!match) return null
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)).toISOString()
}

function stableId(label: string, url: string): string {
  const token = url.replace(/^https?:\/\//i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(-180)
  return `companies-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${token}`
}

function makeJob(input: {
  label: string
  title: string
  company?: string
  location: string
  url: string
  postedAt?: string
  description?: string
  employmentType?: string
  tags?: string[]
}): Job {
  const description = stripHtml(input.description || '').slice(0, MAX_DESCRIPTION)
  return {
    id: stableId(input.label, input.url),
    title: stripHtml(input.title).slice(0, 240),
    company: stripHtml(input.company || input.label).slice(0, 180),
    location: stripHtml(input.location || 'See listing').slice(0, 240),
    url: input.url,
    source: 'companies',
    remote: detectWorkModes(`${input.title} ${input.location} ${description}`).includes('remote'),
    tags: [...new Set([input.label, 'Aviation', ...(input.tags || [])])].slice(0, 8),
    postedAt: input.postedAt || new Date().toISOString(),
    employmentType: input.employmentType,
    description: description || undefined,
    employerType: 'direct',
  }
}

async function fetchAirAstana(): Promise<Job[]> {
  const roots = [
    'https://job.airastana.com/en/Home',
    'https://job.airastana.com/Home',
  ]
  let html = ''
  let root = roots[0]!
  for (const candidate of roots) {
    try {
      html = await fetchHtml(candidate)
      root = candidate
      if (html) break
    } catch {
      // Try the alternate locale before failing the isolated source target.
    }
  }
  if (!html) throw new Error('Air Astana career portal unavailable')

  const out = new Map<string, Job>()
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/Home\/VacancyInfo\/[0-9a-f-]{20,}[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(match[1]!, root)
    const title = stripHtml(match[2])
    if (!url || title.length < 3 || title.length > 240) continue
    const start = match.index || 0
    const block = html.slice(Math.max(0, start - 900), Math.min(html.length, start + 2_500))
    const text = htmlLines(block).join('\n')
    const location = text.split('\n').find((line) => detectCountryCodeFromText(line) === 'KZ' || Boolean(detectCityFromText(line, 'KZ'))) || 'Kazakhstan'
    out.set(url, makeJob({
      label: 'Air Astana / FlyArystan',
      title,
      company: /flyarystan/iu.test(text) ? 'FlyArystan' : 'Air Astana',
      location,
      url,
      description: text,
      tags: ['Kazakhstan', 'Airline'],
    }))
  }

  if (!out.size) {
    const lines = htmlLines(html)
    const marker = lines.findIndex((line) => /(?:latest jobs|последние вакансии|jobs)/iu.test(line))
    if (marker >= 0) {
      for (let i = marker + 1; i < Math.min(lines.length, marker + 80); i += 3) {
        const title = lines[i]
        if (!title || /(?:name of job|название вакансии|career type|specialization|location|see all jobs)/iu.test(title)) continue
        const specialization = lines[i + 1] || ''
        const location = lines[i + 2] || 'Kazakhstan'
        if (title.length < 4 || title.length > 220) continue
        if (detectCountryCodeFromText(`${location} ${lines[i + 3] || ''}`) !== 'KZ') continue
        const url = `${root}#${encodeURIComponent(title.toLowerCase().replace(/\s+/g, '-'))}`
        out.set(url, makeJob({
          label: 'Air Astana / FlyArystan',
          title,
          company: 'Air Astana / FlyArystan',
          location,
          url,
          description: specialization,
          tags: ['Kazakhstan', 'Airline'],
        }))
      }
    }
  }
  return [...out.values()]
}

async function fetchBucharestAirports(): Promise<Job[]> {
  const root = 'https://bucharestairports.ro/cnab/prezentare/organizare/cariere/'
  const html = await fetchHtml(root)
  const byUrl = new Map<string, Job>()

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(match[1]!, root)
    if (!url || new URL(url).hostname !== 'bucharestairports.ro') continue
    const postedAt = dateFromUrl(url)
    if (!postedAt || !recent(postedAt)) continue
    const title = stripHtml(match[2])
    if (title.length < 8 || title.length > 300) continue
    if (!/(?:post(?:uri)?\s+(?:temporar\s+)?vacant|concurs extern|agent de securitate|inginer|arhitect|masinist)/iu.test(title)) continue
    byUrl.set(url, makeJob({
      label: 'Bucharest Airports',
      title,
      company: 'Compania Națională Aeroporturi București',
      location: 'Bucharest / Otopeni, Romania',
      url,
      postedAt,
      tags: ['Romania', 'Airport'],
    }))
  }
  return [...byUrl.values()]
}

async function fetchClujAirport(): Promise<Job[]> {
  const root = 'https://www.airportcluj.ro/oportunitati-de-cariera/'
  const html = await fetchHtml(root)
  const lines = htmlLines(html)
  if (/momentan nu (?:sunt|există).*?(?:oportunit|posturi).*?deschis/iu.test(lines.join(' '))) return []

  const byUrl = new Map<string, Job>()
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(match[1]!, root)
    const title = stripHtml(match[2])
    if (!url || title.length < 5 || title.length > 260) continue
    if (!/(?:post(?:uri)? vacant|angaj|concurs|recrut|carier)/iu.test(title)) continue
    byUrl.set(url, makeJob({
      label: 'Cluj Airport',
      title,
      company: 'Aeroportul Internațional Avram Iancu Cluj',
      location: 'Cluj-Napoca, Romania',
      url,
      tags: ['Romania', 'Airport'],
    }))
  }
  return [...byUrl.values()]
}

async function fetchTarom(): Promise<Job[]> {
  const root = 'https://www.tarom.ro/despre-noi/compania-tarom/cariere/'
  const html = await fetchHtml(root)
  const byUrl = new Map<string, Job>()

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = stripHtml(match[2])
    if (!/(?:anun[țt].*recrut|post.*vacant|agent transport|inginer|referent)/iu.test(title)) continue
    const url = absoluteUrl(match[1]!, root)
    if (!url) continue
    byUrl.set(url, makeJob({
      label: 'TAROM',
      title: title.replace(/^Anun[țt](?: de)? recrutare\s*[-–—:]?\s*/iu, '') || title,
      company: 'TAROM',
      location: /cluj/iu.test(title) ? 'Cluj-Napoca, Romania' : 'Otopeni / Bucharest, Romania',
      url,
      tags: ['Romania', 'Airline'],
    }))
  }
  return [...byUrl.values()]
}

function parseGenericCareerAnchors(
  html: string,
  root: string,
  label: string,
  locationFallback: string,
  tags: string[],
): Job[] {
  const byUrl = new Map<string, Job>()
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(match[1]!, root)
    if (!url) continue
    const path = new URL(url).pathname
    if (!/\/(?:job|jobs|vacanc(?:y|ies)|position|career)\/[a-z0-9][^/?#]{2,}/iu.test(path)) continue
    const title = stripHtml(match[2])
    if (title.length < 4 || title.length > 220) continue
    if (/^(?:view|details?|apply|read more|learn more|search|next|previous)$/iu.test(title)) continue
    const start = match.index || 0
    const block = html.slice(Math.max(0, start - 1_000), Math.min(html.length, start + 3_500))
    const text = htmlLines(block).join('\n')
    const location = text.split('\n').find((line) => Boolean(detectCityFromText(line)) || Boolean(detectCountryCodeFromText(line))) || locationFallback
    byUrl.set(url, makeJob({ label, title, company: label, location, url, description: text, tags }))
  }
  return [...byUrl.values()]
}

async function fetchWizzAir(): Promise<Job[]> {
  const root = 'https://careers.wizzair.com/viewalljobs/'
  return parseGenericCareerAnchors(
    await fetchHtml(root), root, 'Wizz Air', 'Europe / Middle East', ['Airline'],
  )
}

async function fetchRyanair(): Promise<Job[]> {
  const root = 'https://careers.ryanair.com/jobs/'
  return parseGenericCareerAnchors(
    await fetchHtml(root), root, 'Ryanair', 'Europe', ['Airline'],
  )
}

type Loader = { key: string; load: () => Promise<Job[]> }

const AVIATION_LOADERS: Loader[] = [
  { key: 'air-astana', load: fetchAirAstana },
  { key: 'bucharest-airports', load: fetchBucharestAirports },
  { key: 'cluj-airport', load: fetchClujAirport },
  { key: 'tarom', load: fetchTarom },
  { key: 'wizz-air', load: fetchWizzAir },
  { key: 'ryanair', load: fetchRyanair },
]

export const AVIATION_JOB_TARGET_PREFIX = 'aviation-job:'

export function configuredAviationJobTargets(): string[] {
  if (process.env.AVIATION_JOBS_SOURCE === 'off') return []
  return AVIATION_LOADERS.map((loader) => `${AVIATION_JOB_TARGET_PREFIX}${loader.key}`)
}

export function isAviationJobTarget(target: string): boolean {
  return target.startsWith(AVIATION_JOB_TARGET_PREFIX)
}

export async function fetchAviationJobTarget(target: string): Promise<Job[]> {
  if (!isAviationJobTarget(target)) throw new Error(`Unknown aviation target ${target}`)
  const key = target.slice(AVIATION_JOB_TARGET_PREFIX.length)
  const loader = AVIATION_LOADERS.find((candidate) => candidate.key === key)
  if (!loader) throw new Error(`Unknown aviation target ${target}`)
  return loader.load()
}
