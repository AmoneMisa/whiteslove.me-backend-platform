import { moneyCurrencyFromText } from '@whiteslove/parsing-lexicon/currency'
import { detectEmploymentTypes, detectWorkModes, detectWorkSchedules } from '@whiteslove/parsing-lexicon/hiring-work-semantics'
import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'
import { decodeHtmlEntities as decodeEntities, stripHtml } from './htmlText'
import type { Job } from '~~/shared/contracts/jobs'

const BASE_URL = 'https://jobs.ua/vacancy'
const MAX_DESCRIPTION = 1_200

function attribute(fragment: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = fragment.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))
  return decodeEntities(match?.[2] || '').trim()
}

function taggedContent(fragment: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = fragment.match(
    new RegExp(`<([a-z][\\w:-]*)\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'),
  )
  return match?.[2] || ''
}

function salaryFrom(value: string): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'> {
  const text = stripHtml(value)
  if (!text) return {}

  const amounts = [...text.matchAll(/\d[\d\s.,]*/g)]
    .map((match) => Number.parseInt(match[0].replace(/\D/g, ''), 10))
    .filter((amount) => Number.isFinite(amount) && amount > 0)
  if (!amounts.length) return {}

  const salaryCurrency = moneyCurrencyFromText(text) || undefined

  const salaryMin = amounts[0]
  const salaryMax = amounts.length > 1 ? amounts[1] : amounts[0]
  return {
    salaryMin: Math.min(salaryMin!, salaryMax!),
    salaryMax: Math.max(salaryMin!, salaryMax!),
    salaryCurrency,
    salaryPeriod: 'month',
  }
}

function scheduleFrom(card: string): string {
  const match = card.match(
    /<span\b[^>]*class=["'][^"']*caption[^"']*["'][^>]*>\s*(?:Графік роботи|График работы)\s*:\s*<\/span>\s*<span\b[^>]*class=["'][^"']*black-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu,
  )
  return stripHtml(match?.[1] || '')
}

function workFields(schedule: string): Pick<Job, 'remote' | 'workMode' | 'employmentKind' | 'workSchedules'> {
  const remote = detectWorkModes(schedule).includes('remote')
  const parttime = detectEmploymentTypes(schedule).includes('part_time')
  const shift = detectWorkSchedules(schedule).includes('shift')
  return {
    remote,
    workMode: remote ? 'remote' : 'office',
    employmentKind: parttime ? 'parttime' : 'fulltime',
    workSchedules: shift ? ['shift'] : undefined,
  }
}

function cardsFrom(html: string): string[] {
  const starts = [...html.matchAll(/<li\b[^>]*class=["'][^"']*\bb-vacancy__item\b[^"']*["'][^>]*>/gi)]
  return starts.map((match, index) => {
    const start = match.index || 0
    const next = starts[index + 1]?.index
    return html.slice(start, next === undefined ? Math.min(html.length, start + 30_000) : next)
  })
}

/** Parse only the public vacancy-list cards; no vacancy detail requests are needed. */
export function parseJobsUaVacancies(html: string, now = new Date()): Job[] {
  const jobs: Job[] = []
  const seen = new Set<string>()

  for (const card of cardsFrom(html)) {
    const opening = card.match(/^<li\b[^>]*>/i)?.[0] || ''
    const numericId = attribute(opening, 'id')
    const titleTag = card.match(
      /<a\b([^>]*class=["'][^"']*\bb-vacancy__top__title\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/i,
    )
    const title = stripHtml(titleTag?.[2] || '')
    const rawHref = attribute(titleTag?.[1] || '', 'href')
    if (!numericId || !/^\d+$/.test(numericId) || !title || !rawHref || seen.has(numericId)) continue

    let url: URL
    try {
      url = new URL(rawHref, BASE_URL)
    } catch {
      continue
    }
    if (!/(?:^|\.)jobs\.ua$/i.test(url.hostname) || !/\/job-[^/?#]+-\d+/i.test(url.pathname)) continue

    const tech = taggedContent(card, 'b-vacancy__tech')
    const companyTag = tech.match(/<span\b([^>]*class=["'][^"']*\blink__hidden\b[^"']*["'][^>]*)>([\s\S]*?)<\/span>/i)
    const company = stripHtml(attribute(companyTag?.[1] || '', 'title') || companyTag?.[2] || '')
    const cityTag = tech.match(/<a\b[^>]*href=["'][^"']*\/city\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
    const city = stripHtml(cityTag?.[1] || '')
    const description = stripHtml(taggedContent(card, 'b-text')).slice(0, MAX_DESCRIPTION)
    const schedule = scheduleFrom(card)
    const salary = salaryFrom(taggedContent(card, 'b-vacancy__top__pay'))

    seen.add(numericId)
    jobs.push({
      id: `companies-jobs-ua-${numericId}`,
      title,
      company: company || 'Jobs.ua employer',
      location: city ? `${city}, Ukraine` : 'Ukraine',
      city: city || undefined,
      country: 'UA',
      url: url.toString(),
      applyUrl: url.toString(),
      source: 'companies',
      tags: ['Jobs.ua'],
      postedAt: now.toISOString(),
      description: description || undefined,
      employmentType: schedule || undefined,
      schedule: schedule || undefined,
      employerType: 'board',
      ...workFields(schedule),
      ...salary,
    })
  }

  return jobs
}

function listingUrl(page: number): string {
  const path = page === 1 ? BASE_URL : `${BASE_URL}/page-${page}`
  return `${path}?period=14`
}

async function fetchPage(page: number): Promise<string> {
  const response = await fetch(listingUrl(page), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.7',
      'User-Agent': 'jobFinder/1.0 (vacancy search; contact: admin@whiteslove.me)',
    },
  })
  if (!response.ok) throw new Error(`jobs.ua -> ${response.status}`)
  return response.text()
}

export async function fetchJobsUaJobs(q: string): Promise<Job[]> {
  if (String(process.env.JOBS_UA_SOURCE || 'on').toLowerCase() === 'off') return []

  const run = await crawlStandardJobBoard({
    key: 'jobs-ua',
    fetchPage,
    parsePage: (html) => parseJobsUaVacancies(html),
  })

  if (!q.trim()) return run.jobs
  const needle = q.toLocaleLowerCase('uk')
  return run.jobs.filter((job) =>
    `${job.title} ${job.company} ${job.location} ${job.description || ''}`
      .toLocaleLowerCase('uk')
      .includes(needle),
  )
}
