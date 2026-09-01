import type { Job } from './jobTypes'
import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'

const API_URL = 'https://api.hh.ru/vacancies'
const USER_AGENT = 'WhitesLove-Hiring-Aggregator/1.0 (admin@whiteslove.me)'

type HhCountry = 'UZ' | 'KZ' | 'KG'
export interface HhTarget {
  country: HhCountry
  area: string
  host: string
  label: string
  fallbackLocation: string
}

const STANDARD_TARGETS: HhTarget[] = [
  { country: 'UZ', area: '2759', host: 'hh.uz', label: 'HH.uz', fallbackLocation: 'Uzbekistan' },
  { country: 'KZ', area: '40', host: 'hh.kz', label: 'HH.kz', fallbackLocation: 'Kazakhstan' },
  { country: 'KG', area: '48', host: 'headhunter.kg', label: 'HeadHunter.kg', fallbackLocation: 'Kyrgyzstan' },
]

interface HhSalary {
  from?: number | null
  to?: number | null
  currency?: string | null
  gross?: boolean | null
}

interface HhVacancy {
  id?: string
  name?: string
  alternate_url?: string
  published_at?: string
  employer?: { name?: string }
  area?: { name?: string }
  salary?: HhSalary | null
  snippet?: { requirement?: string | null; responsibility?: string | null }
  schedule?: { id?: string; name?: string } | null
  employment?: { id?: string; name?: string } | null
  professional_roles?: Array<{ name?: string }>
}

interface HhVacancyPage {
  items?: HhVacancy[]
}

export function configuredHhAreas(): HhTarget[] {
  const countries = String(process.env.HH_JOB_COUNTRIES || 'UZ,KZ,KG')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
  const enabled = new Set(countries)
  const targets = STANDARD_TARGETS.filter((target) => enabled.has(target.country))

  // Supplemental area IDs are source configuration, not execution policy.
  const extraAreas = String(process.env.HH_JOB_AREAS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  for (const area of extraAreas) {
    if (targets.some((target) => target.area === area)) continue
    targets.push({
      country: 'UZ',
      area,
      host: 'hh.uz',
      label: 'HH.uz',
      fallbackLocation: 'Uzbekistan',
    })
  }
  return targets
}

function dateFrom(): string {
  return new Date(Date.now() - 14 * 86_400_000).toISOString()
}

function isRemote(item: HhVacancy): boolean {
  return item.schedule?.id === 'remote' || /(?:remote|удал[её]н|masofaviy|қашықтан)/iu.test(
    `${item.name || ''} ${item.schedule?.name || ''}`,
  )
}

function description(item: HhVacancy): string | undefined {
  const value = [item.snippet?.requirement, item.snippet?.responsibility]
    .map((part) => String(part || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return value || undefined
}

export function mapHhVacancy(item: HhVacancy, target: HhTarget = STANDARD_TARGETS[0]!): Job | null {
  const id = String(item.id || '').trim()
  const title = String(item.name || '').trim()
  const url = String(item.alternate_url || '').trim()
  const posted = Date.parse(String(item.published_at || ''))
  if (!id || !title || !url || !Number.isFinite(posted)) return null

  const roles = (item.professional_roles || []).map((role) => String(role.name || '').trim()).filter(Boolean)
  const stableId = target.country === 'UZ' ? `hh-${id}` : `hh-${target.country.toLowerCase()}-${id}`
  return {
    id: stableId,
    title,
    company: String(item.employer?.name || 'Не указан').trim(),
    location: String(item.area?.name || target.fallbackLocation).trim(),
    url,
    source: 'hh',
    remote: isRemote(item),
    tags: [target.label, ...roles].slice(0, 8),
    postedAt: new Date(posted).toISOString(),
    description: description(item),
    employmentType: item.employment?.name || undefined,
    salaryMin: typeof item.salary?.from === 'number' ? item.salary.from : undefined,
    salaryMax: typeof item.salary?.to === 'number' ? item.salary.to : undefined,
    salaryCurrency: item.salary?.currency || undefined,
    salaryGross: typeof item.salary?.gross === 'boolean' ? item.salary.gross : undefined,
    schedule: item.schedule?.name || undefined,
    country: target.country,
    city: item.area?.name || undefined,
    employerType: 'board',
    hiringKind: 'vacancy',
  }
}

async function fetchPage(target: HhTarget, crawlerPage: number): Promise<string> {
  const params = new URLSearchParams({
    host: target.host,
    area: target.area,
    page: String(crawlerPage - 1),
    // HH documents 100 as the maximum API page size. This is pagination shape,
    // not a source-local run/item cap; traversal belongs to the shared crawler.
    per_page: '100',
    order_by: 'publication_time',
    date_from: dateFrom(),
  })
  const query = String(process.env.HH_JOB_QUERY || '').trim()
  if (query) params.set('text', query)

  const response = await fetch(`${API_URL}?${params}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'HH-User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  })
  // HH returns 400 when the requested page is outside the available range.
  // Present that upstream terminal condition as an empty page to the crawler.
  if (response.status === 400 && crawlerPage > 1) return JSON.stringify({ items: [] })
  if (!response.ok) throw new Error(`api.hh.ru (${target.host}) -> ${response.status}`)
  return response.text()
}

function parsePage(raw: string, target: HhTarget): Job[] {
  let data: HhVacancyPage
  try { data = JSON.parse(raw) as HhVacancyPage } catch { return [] }
  return (data.items || [])
    .map((item) => mapHhVacancy(item, target))
    .filter((job): job is Job => Boolean(job))
}

function targetKey(target: HhTarget): string {
  return `${target.country.toLowerCase()}:area-${target.area}`
}

export const HH_JOB_TARGET_PREFIX = 'hh-job-source:'

export function configuredHhJobTargets(): string[] {
  if (process.env.HH_JOB_SOURCE === 'off') return []
  return configuredHhAreas().map((target) => `${HH_JOB_TARGET_PREFIX}${targetKey(target)}`)
}

export function isHhJobTarget(target: string): boolean {
  return target.startsWith(HH_JOB_TARGET_PREFIX)
}

export async function fetchHhJobTarget(target: string): Promise<Job[]> {
  if (!isHhJobTarget(target)) throw new Error(`Unknown HH job target ${target}`)
  const key = target.slice(HH_JOB_TARGET_PREFIX.length)
  const config = configuredHhAreas().find((candidate) => targetKey(candidate) === key)
  if (!config) throw new Error(`Unknown HH job target ${target}`)

  const run = await crawlStandardJobBoard({
    key: `hh:${targetKey(config)}`,
    fetchPage: (page) => fetchPage(config, page),
    parsePage: (raw) => parsePage(raw, config),
  })
  return run.jobs
}
