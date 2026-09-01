import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'
import type { Job } from './jobTypes'
import { detectWorkModes } from './hiringLexicon'
import { absoluteHttpUrl as absoluteUrl, stripHtml } from './htmlText'

const UA = 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)'

export type RegionalGeneralEmployer = {
  label: string
  country: 'UA' | 'RO' | 'UZ'
  url: string
  hosts: string[]
  pathHints: RegExp[]
}

export const REGIONAL_GENERAL_EMPLOYERS: RegionalGeneralEmployer[] = [
  {
    label: 'PrivatBank', country: 'UA', url: 'https://work.privatbank.ua/?nomob=1',
    hosts: ['work.privatbank.ua'], pathHints: [/vacanc/i, /job/i, /position/i],
  },
  {
    label: 'Sense Bank', country: 'UA', url: 'https://sensebank.ua/vacancies',
    hosts: ['sensebank.ua'], pathHints: [/vacanc/i],
  },
  {
    label: 'Banca Transilvania', country: 'RO', url: 'https://cariere.bancatransilvania.ro/joburi-disponibile/',
    hosts: ['cariere.bancatransilvania.ro'], pathHints: [/job/i],
  },
  {
    label: 'ING Romania', country: 'RO', url: 'https://careers.ing.com/en/search-jobs/romania',
    hosts: ['careers.ing.com'], pathHints: [/job/i, /search-jobs/i],
  },
  {
    label: 'Raiffeisen Bank Romania', country: 'RO', url: 'https://cariere.raiffeisen.ro/',
    hosts: ['cariere.raiffeisen.ro'], pathHints: [/job/i, /post/i, /vacanc/i],
  },
  {
    label: 'TBC Uzbekistan', country: 'UZ', url: 'https://tbcbank.uz/career/vacancies/',
    hosts: ['tbcbank.uz'], pathHints: [/vacanc/i, /career/i],
  },
  {
    label: 'Korzinka', country: 'UZ', url: 'https://rabota.korzinka.uz/vacancies/',
    hosts: ['rabota.korzinka.uz', 'ish.korzinka.uz'], pathHints: [/vacanc/i],
  },
  {
    label: 'Uzum Bank', country: 'UZ', url: 'https://uzumbank.uz/en/vacancies/',
    hosts: ['uzumbank.uz'], pathHints: [/vacanc/i],
  },
]

function acceptedUrl(url: string, employer: RegionalGeneralEmployer): boolean {
  try {
    const parsed = new URL(url)
    if (!employer.hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return false
    const target = `${parsed.pathname}${parsed.search}`
    return employer.pathHints.some((pattern) => pattern.test(target))
  } catch {
    return false
  }
}

function jsonLdNodes(value: any): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes)
  return value?.['@graph'] ? jsonLdNodes(value['@graph']) : [value]
}

function postingLocation(node: any, country: string): string {
  const raw = Array.isArray(node?.jobLocation) ? node.jobLocation : node?.jobLocation ? [node.jobLocation] : []
  const locations = raw.map((item: any) => item?.address || item).map((address: any) => [
    address?.addressLocality,
    address?.addressRegion,
    address?.addressCountry?.name || address?.addressCountry,
  ].filter(Boolean).join(', ')).filter(Boolean)
  return [...new Set(locations)].join('; ') || (node?.jobLocationType === 'TELECOMMUTE' ? 'Remote' : country)
}

export function parseRegionalEmployerPage(html: string, employer: RegionalGeneralEmployer): Job[] {
  const byUrl = new Map<string, Job>()
  const jsonLd = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let scriptMatch: RegExpExecArray | null

  while ((scriptMatch = jsonLd.exec(html))) {
    let parsed: any
    try { parsed = JSON.parse(scriptMatch[1]!) } catch { continue }
    for (const node of jsonLdNodes(parsed)) {
      const type = node?.['@type']
      if (!(type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) || !node?.title) continue
      const url = absoluteUrl(String(node.url || node.sameAs || ''), employer.url)
      if (!url || !acceptedUrl(url, employer)) continue
      const location = postingLocation(node, employer.country)
      const description = stripHtml(node.description).slice(0, 6000)
      byUrl.set(url, {
        id: `companies-general-${employer.country.toLowerCase()}-${employer.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${url}`,
        title: stripHtml(node.title).slice(0, 240),
        company: employer.label,
        location,
        url,
        source: 'companies',
        remote: node.jobLocationType === 'TELECOMMUTE' || detectWorkModes(`${node.title} ${location} ${description}`).includes('remote'),
        tags: [employer.country],
        postedAt: node.datePosted && Number.isFinite(Date.parse(node.datePosted)) ? new Date(node.datePosted).toISOString() : new Date().toISOString(),
        employmentType: Array.isArray(node.employmentType) ? node.employmentType[0] : node.employmentType,
        description: description || undefined,
        employerType: 'direct',
      })
    }
  }

  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let anchor: RegExpExecArray | null
  while ((anchor = anchorRe.exec(html))) {
    const url = absoluteUrl(anchor[1]!, employer.url)
    if (!url || !acceptedUrl(url, employer) || byUrl.has(url)) continue
    const title = stripHtml(anchor[2])
    if (title.length < 4 || title.length > 180) continue
    if (/^(?:вакансии|vacancies|jobs?|career|careers|apply|learn more|details|подробнее|усі вакансії|всі вакансії)$/iu.test(title)) continue

    byUrl.set(url, {
      id: `companies-general-${employer.country.toLowerCase()}-${employer.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${url}`,
      title,
      company: employer.label,
      location: employer.country,
      url,
      source: 'companies',
      remote: detectWorkModes(title).includes('remote'),
      tags: [employer.country],
      postedAt: new Date().toISOString(),
      employerType: 'direct',
    })
  }

  return [...byUrl.values()]
}

function employerKey(employer: RegionalGeneralEmployer): string {
  return `${employer.country.toLowerCase()}-${employer.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

export const REGIONAL_GENERAL_EMPLOYER_TARGET_PREFIX = 'regional-general-employer:'

export function configuredRegionalGeneralEmployerTargets(): string[] {
  if (String(process.env.REGIONAL_GENERAL_EMPLOYER_SOURCE || 'on').toLowerCase() === 'off') return []
  return REGIONAL_GENERAL_EMPLOYERS.map((employer) => `${REGIONAL_GENERAL_EMPLOYER_TARGET_PREFIX}${employerKey(employer)}`)
}

export function isRegionalGeneralEmployerTarget(target: string): boolean {
  return target.startsWith(REGIONAL_GENERAL_EMPLOYER_TARGET_PREFIX)
}

function employerForTarget(target: string): RegionalGeneralEmployer | undefined {
  if (!isRegionalGeneralEmployerTarget(target)) return undefined
  const key = target.slice(REGIONAL_GENERAL_EMPLOYER_TARGET_PREFIX.length)
  return REGIONAL_GENERAL_EMPLOYERS.find((employer) => employerKey(employer) === key)
}

async function fetchEmployerPage(employer: RegionalGeneralEmployer): Promise<string> {
  const response = await fetch(employer.url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en,ru,uk,ro,uz;q=0.8',
    },
  })
  if (!response.ok) throw new Error(`${employer.label} -> ${response.status}`)
  return response.text()
}

export async function fetchRegionalGeneralEmployerTarget(target: string): Promise<Job[]> {
  const employer = employerForTarget(target)
  if (!employer) throw new Error(`Unknown regional general employer target ${target}`)

  const run = await crawlStandardJobBoard({
    key: `regional-general:${employerKey(employer)}`,
    fetchPage: () => fetchEmployerPage(employer),
    parsePage: (html) => parseRegionalEmployerPage(html, employer),
  })
  return run.jobs
}
