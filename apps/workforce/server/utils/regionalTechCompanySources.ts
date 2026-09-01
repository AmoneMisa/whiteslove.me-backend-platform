import type { Job } from '~~/shared/contracts/jobs'
import { detectWorkModes } from './hiringLexicon'

const UA = 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)'

export type RegionalCompanyCountry = 'UA' | 'RO' | 'UZ'
export type RegionalCompanyAts = 'lever' | 'smartrecruiters'

export type RegionalTechCompany = {
  ats: RegionalCompanyAts
  handle: string
  label: string
  country: RegionalCompanyCountry
  aliases: string[]
}

// Direct employer feeds verified live in 2026-08. Some employers are global;
// aliases below deliberately keep only vacancies that explicitly target the
// requested country/cities so they do not flood the shared `companies` source.
export const REGIONAL_TECH_COMPANIES: RegionalTechCompany[] = [
  { ats: 'lever', handle: 'provectus', label: 'Provectus', country: 'UA', aliases: ['ukraine', 'kyiv', 'kiev', 'odesa', 'odessa', 'lviv'] },
  // Kyivstar uses "All" for many Ukraine-wide roles on its own country board.
  { ats: 'lever', handle: 'kyivstar', label: 'Kyivstar', country: 'UA', aliases: ['ukraine', 'kyiv', 'kiev', 'all'] },
  { ats: 'smartrecruiters', handle: 'SigmaSoftware2', label: 'Sigma Software', country: 'UA', aliases: ['ukraine', 'kyiv', 'kiev', 'kharkiv', 'odesa', 'odessa', 'lviv', 'dnipro'] },

  { ats: 'lever', handle: '3pillarglobal', label: '3Pillar', country: 'RO', aliases: ['romania', 'bucharest', 'cluj', 'iasi', 'timișoara', 'timisoara'] },
  { ats: 'lever', handle: 'brillio-2', label: 'Brillio', country: 'RO', aliases: ['romania', 'bucharest', 'bihor', 'cluj', 'oradea'] },
  { ats: 'lever', handle: 'viseven', label: 'Viseven', country: 'RO', aliases: ['romania', 'bucharest'] },
  { ats: 'lever', handle: 'civitta', label: 'Civitta', country: 'RO', aliases: ['romania', 'bucharest'] },
  { ats: 'lever', handle: 'qualysoft', label: 'Qualysoft', country: 'RO', aliases: ['romania', 'bucharest'] },
  { ats: 'smartrecruiters', handle: 'Endava', label: 'Endava', country: 'RO', aliases: ['romania', 'bucharest', 'cluj', 'iasi', 'timișoara', 'timisoara'] },
  { ats: 'smartrecruiters', handle: 'ACCESA', label: 'Accesa', country: 'RO', aliases: ['romania', 'cluj', 'cluj-napoca', 'oradea'] },

  { ats: 'lever', handle: 'binance', label: 'Binance', country: 'UZ', aliases: ['uzbekistan', 'tashkent', 'toshkent'] },
  { ats: 'lever', handle: 'weloglobal', label: 'Welo Global', country: 'UZ', aliases: ['uzbekistan', 'tashkent', 'toshkent'] },
  { ats: 'smartrecruiters', handle: 'Gcore', label: 'Gcore', country: 'UZ', aliases: ['uzbekistan', 'tashkent', 'toshkent'] },
  { ats: 'smartrecruiters', handle: 'ACCESA', label: 'Accesa', country: 'UZ', aliases: ['uzbekistan', 'tashkent', 'toshkent'] },
]

type LeverPosting = {
  id?: string
  text?: string
  hostedUrl?: string
  createdAt?: number
  descriptionPlain?: string
  description?: string
  categories?: {
    location?: string
    team?: string
    department?: string
    commitment?: string
  }
  workplaceType?: string
}

type SmartRecruitersPosting = {
  id?: string
  name?: string
  releasedDate?: string
  location?: {
    city?: string
    region?: string
    country?: string
    fullLocation?: string
    remote?: boolean
  }
  function?: { label?: string }
  industry?: { label?: string }
  department?: { label?: string }
  typeOfEmployment?: { label?: string }
}

function stripHtml(value: unknown): string {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesLocation(location: string, company: RegionalTechCompany): boolean {
  const normalized = location.toLocaleLowerCase('en')
  if (!normalized) return false
  return company.aliases.some((alias) => normalized.includes(alias.toLocaleLowerCase('en')))
}

export function mapRegionalLeverPostings(
  postings: LeverPosting[],
  company: RegionalTechCompany,
): Job[] {
  return postings.flatMap((posting) => {
    const location = String(posting.categories?.location || '')
    if (!posting.text || !posting.hostedUrl || !matchesLocation(location, company)) return []

    const description = stripHtml(posting.descriptionPlain || posting.description).slice(0, 6000)
    const semanticText = `${posting.text} ${location} ${posting.workplaceType || ''} ${description}`

    return [{
      id: `companies-regional-${company.country.toLowerCase()}-${company.handle}-${posting.id || posting.hostedUrl}`,
      title: posting.text,
      company: company.label,
      location: location || company.country,
      url: posting.hostedUrl,
      source: 'companies' as const,
      remote: detectWorkModes(semanticText).includes('remote') || /remote/i.test(String(posting.workplaceType || '')),
      tags: [company.label, company.country, posting.categories?.team, posting.categories?.department]
        .filter((value): value is string => Boolean(value))
        .slice(0, 8),
      postedAt: new Date(posting.createdAt || Date.now()).toISOString(),
      employmentType: posting.categories?.commitment,
      description: description || undefined,
      employerType: 'direct' as const,
    }]
  })
}

function smartRecruitersLocation(posting: SmartRecruitersPosting): string {
  return posting.location?.fullLocation
    || [posting.location?.city, posting.location?.region, posting.location?.country]
      .filter(Boolean)
      .join(', ')
    || ''
}

export function mapRegionalSmartRecruitersPostings(
  postings: SmartRecruitersPosting[],
  company: RegionalTechCompany,
): Job[] {
  return postings.flatMap((posting) => {
    const location = smartRecruitersLocation(posting)
    if (!posting.id || !posting.name || !matchesLocation(location, company)) return []

    return [{
      id: `companies-regional-${company.country.toLowerCase()}-sr-${company.handle}-${posting.id}`,
      title: posting.name,
      company: company.label,
      location: location || company.country,
      url: `https://jobs.smartrecruiters.com/${company.handle}/${posting.id}`,
      source: 'companies' as const,
      remote: posting.location?.remote === true || detectWorkModes(`${posting.name} ${location}`).includes('remote'),
      tags: [company.label, company.country, posting.function?.label, posting.department?.label, posting.industry?.label]
        .filter((value): value is string => Boolean(value))
        .slice(0, 8),
      postedAt: new Date(posting.releasedDate || Date.now()).toISOString(),
      employmentType: posting.typeOfEmployment?.label,
      employerType: 'direct' as const,
    }]
  })
}

async function fetchLeverCompany(company: RegionalTechCompany): Promise<Job[]> {
  const response = await fetch(
    `https://api.lever.co/v0/postings/${encodeURIComponent(company.handle)}?mode=json`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
  )
  if (!response.ok) throw new Error(`${company.label} -> ${response.status}`)
  const postings = await response.json() as LeverPosting[]
  return mapRegionalLeverPostings(Array.isArray(postings) ? postings : [], company)
}

async function fetchSmartRecruitersCompany(company: RegionalTechCompany): Promise<Job[]> {
  const response = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.handle)}/postings`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
  )
  if (!response.ok) throw new Error(`${company.label} -> ${response.status}`)
  const data = await response.json() as { content?: SmartRecruitersPosting[] }
  return mapRegionalSmartRecruitersPostings(Array.isArray(data.content) ? data.content : [], company)
}

async function fetchRegionalCompany(company: RegionalTechCompany): Promise<Job[]> {
  return company.ats === 'smartrecruiters'
    ? fetchSmartRecruitersCompany(company)
    : fetchLeverCompany(company)
}

function companyKey(company: RegionalTechCompany): string {
  return `${company.country.toLowerCase()}:${company.ats}:${company.handle}`
}

export const REGIONAL_TECH_COMPANY_TARGET_PREFIX = 'regional-tech-company:'

export function configuredRegionalTechCompanyTargets(): string[] {
  if (String(process.env.REGIONAL_TECH_COMPANY_SOURCE || 'on').toLowerCase() === 'off') return []
  return REGIONAL_TECH_COMPANIES.map((company) => `${REGIONAL_TECH_COMPANY_TARGET_PREFIX}${companyKey(company)}`)
}

export function isRegionalTechCompanyTarget(target: string): boolean {
  return target.startsWith(REGIONAL_TECH_COMPANY_TARGET_PREFIX)
}

export async function fetchRegionalTechCompanyTarget(target: string): Promise<Job[]> {
  if (!isRegionalTechCompanyTarget(target)) throw new Error(`Unknown regional tech company target ${target}`)
  const key = target.slice(REGIONAL_TECH_COMPANY_TARGET_PREFIX.length)
  const company = REGIONAL_TECH_COMPANIES.find((candidate) => companyKey(candidate) === key)
  if (!company) throw new Error(`Unknown regional tech company target ${target}`)
  return fetchRegionalCompany(company)
}
