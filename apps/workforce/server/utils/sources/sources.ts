// Direct source adapters only. Paginated, multi-board and multi-channel sources
// are exposed as durable queue targets in dedicated target modules.

import { XMLParser } from 'fast-xml-parser'
import type { Job } from '~~/shared/contracts/jobs'
import { detectWorkModes } from '../hiring/hiringLexicon'

const UA = 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)'

function stripHtml(html: string | undefined | null): string {
  if (!html) return ''
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Keep complete vacancy descriptions for enrichment. Presentation limits belong
// to the read/UI layer, not ingestion.
const DESC_MAX = Number.POSITIVE_INFINITY

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers || {}) },
  })
  if (!response.ok) {
    let host = 'upstream'
    try { host = new URL(url).host } catch { /* keep generic label */ }
    throw new Error(`${host} -> ${response.status}`)
  }
  return response.json() as Promise<T>
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

// Complete current-result API: no adapter-level pagination or fan-out.
export async function fetchRemotive(q: string): Promise<Job[]> {
  const url = `https://remotive.com/api/remote-jobs${q ? `?search=${encodeURIComponent(q)}` : ''}`
  const data = await fetchJson<{ jobs?: any[] }>(url)
  return (data.jobs || []).map((job) => ({
    id: `remotive-${job.id}`,
    title: job.title,
    company: job.company_name,
    location: job.candidate_required_location || 'Remote',
    url: job.url,
    source: 'remotive' as const,
    remote: true,
    tags: (job.tags || []).slice(0, 8),
    postedAt: new Date(job.publication_date).toISOString(),
    employmentType: job.job_type || undefined,
    description: stripHtml(job.description).slice(0, DESC_MAX),
  }))
}

// Complete current-result API: no adapter-level pagination or fan-out.
export async function fetchRemoteOk(_q: string): Promise<Job[]> {
  const data = await fetchJson<any[]>('https://remoteok.com/api')
  return (data || [])
    .filter((job) => job && job.id && job.position)
    .map((job) => ({
      id: `remoteok-${job.id}`,
      title: job.position,
      company: job.company || 'Unknown',
      location: job.location || 'Remote',
      url: job.url || `https://remoteok.com/remote-jobs/${job.slug || job.id}`,
      source: 'remoteok' as const,
      remote: true,
      tags: (job.tags || []).slice(0, 8),
      postedAt: job.date ? new Date(job.date).toISOString() : new Date().toISOString(),
      salaryMin: typeof job.salary_min === 'number' ? job.salary_min : undefined,
      salaryMax: typeof job.salary_max === 'number' ? job.salary_max : undefined,
      salaryCurrency: job.salary_min ? 'USD' : undefined,
      description: stripHtml(job.description).slice(0, DESC_MAX),
    }))
}

// Complete current-result API: no adapter-level pagination or fan-out.
export async function fetchArbeitnow(_q: string): Promise<Job[]> {
  const data = await fetchJson<{ data?: any[] }>('https://www.arbeitnow.com/api/job-board-api')
  return (data.data || []).map((job) => {
    const tags = Array.isArray(job.tags) ? job.tags : job.tags ? [job.tags] : []
    const jobTypes = Array.isArray(job.job_types) ? job.job_types : job.job_types ? [job.job_types] : []
    return {
      id: `arbeitnow-${job.slug}`,
      title: job.title,
      company: job.company_name,
      location: job.location || (job.remote ? 'Remote' : 'Unknown'),
      url: job.url,
      source: 'arbeitnow' as const,
      remote: Boolean(job.remote),
      tags: [...tags, ...jobTypes].slice(0, 8),
      postedAt: new Date((job.created_at || 0) * 1000).toISOString(),
      employmentType: jobTypes[0],
      description: stripHtml(job.description).slice(0, DESC_MAX),
    }
  })
}

// Jobicy exposes its current remote feed as one request. Do not impose an
// adapter-local `count` cap; use the service's feed contract as-is.
export async function fetchJobicy(_q: string): Promise<Job[]> {
  const data = await fetchJson<{ jobs?: any[] }>('https://jobicy.com/api/v2/remote-jobs')
  return (data.jobs || []).map((job) => ({
    id: `jobicy-${job.id}`,
    title: job.jobTitle,
    company: job.companyName || 'Unknown',
    location: job.jobGeo || 'Remote',
    url: job.url,
    source: 'jobicy' as const,
    remote: true,
    tags: [job.jobIndustry, job.jobLevel].flat().filter(Boolean).slice(0, 8),
    postedAt: job.pubDate ? new Date(job.pubDate).toISOString() : new Date().toISOString(),
    employmentType: Array.isArray(job.jobType) ? job.jobType[0] : job.jobType,
    description: stripHtml(job.jobDescription || job.jobExcerpt).slice(0, DESC_MAX),
  }))
}

const DEVKG_RSS_URL = 'https://devkg.com/rss/jobs.xml'

function parseDevKgAmount(value: string | undefined): number | undefined {
  if (!value) return undefined
  const amount = Number(value.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(amount) ? amount : undefined
}

function parseDevKgSalary(text: string): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency'> {
  const match = text.match(
    /\b(от|до)?\s*([\d\s]+(?:[.,]\d+)?)\s*(?:[-–—]\s*([\d\s]+(?:[.,]\d+)?))?\s*(KGS|USD|EUR)\b/i,
  )
  if (!match) return {}
  const qualifier = match[1]?.toLowerCase()
  const first = parseDevKgAmount(match[2])
  const second = parseDevKgAmount(match[3])
  return {
    salaryMin: qualifier === 'до' ? undefined : first,
    salaryMax: second ?? (qualifier === 'до' ? first : undefined),
    salaryCurrency: match[4]!.toUpperCase(),
  }
}

// DevKG publishes the full public RSS feed directly.
export async function fetchDevKg(q: string): Promise<Job[]> {
  if (process.env.DEVKG_SOURCE === 'off') return []
  const xml = await fetchText(DEVKG_RSS_URL)
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml)
  const rawItems = parsed?.rss?.channel?.item || []
  const items = Array.isArray(rawItems) ? rawItems : [rawItems]

  const jobs = items.map((item: any, index: number): Job => {
    const fullTitle = String(item.title?.['#text'] || item.title || '').trim()
    const separator = fullTitle.lastIndexOf(' - ')
    const title = separator > 0 ? fullTitle.slice(0, separator).trim() : fullTitle
    const company = separator > 0 ? fullTitle.slice(separator + 3).trim() : 'DevKG employer'
    const rawDescription = String(item.description?.['#text'] || item.description || '')
    const description = stripHtml(rawDescription)
    const typeMatch = description.match(/\bТип:\s*(.+?)(?=\s+(?:от|до|\d)\s*[\d\s]*\s*(?:KGS|USD|EUR)\b)/i)
    const employmentType = typeMatch?.[1]?.trim()
    const url = String(item.link?.['#text'] || item.link || '')
    const guid = String(item.guid?.['#text'] || item.guid || url || `${title}-${index}`)

    return {
      id: `devkg-${guid}`,
      title: title || 'Untitled vacancy',
      company,
      location: 'Kyrgyzstan',
      url,
      source: 'devkg',
      remote: detectWorkModes(`${employmentType || ''} ${description}`).includes('remote'),
      tags: ['DevKG', 'Kyrgyzstan'],
      postedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      employmentType,
      ...parseDevKgSalary(description),
      salaryPeriod: /в месяц|monthly|per month/i.test(description) ? 'month' : undefined,
      description: description.slice(0, DESC_MAX),
    }
  })

  if (!q.trim()) return jobs
  const needle = q.toLocaleLowerCase('ru')
  return jobs.filter((job) =>
    `${job.title} ${job.company} ${job.description || ''}`.toLocaleLowerCase('ru').includes(needle),
  )
}

export { isLikelyTelegramVacancy } from '../../vacancies/sources/telegramVacancyClassifier'
