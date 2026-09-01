import type { Job } from '~~/shared/contracts/jobs'
import { detectWorkModes } from './hiringLexicon'

const UA = 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)'

export type TargetMarket = 'UA' | 'RO' | 'UZ' | 'US' | 'CA' | 'CY' | 'KG' | 'KZ' | 'CN' | 'JP' | 'KR' | 'REMOTE'
export type BoardProvider = 'lever' | 'greenhouse'

export type RegionalBoardTarget = {
  provider?: BoardProvider
  handle: string
  label: string
  market: TargetMarket
  aliases: string[]
}

// Additional direct employers verified live in 2026-08. The same company may
// appear in more than one market when its public ATS board explicitly lists
// vacancies for those countries. URL deduplication collapses overlaps later.
export const EXPANDED_REGIONAL_REMOTE_COMPANIES: RegionalBoardTarget[] = [
  { handle: 'tsmg', label: 'TSMG', market: 'RO', aliases: ['romania', 'bucharest'] },
  { handle: 'companial', label: 'Companial', market: 'RO', aliases: ['romania', 'bucharest'] },
  { handle: 'remofirst', label: 'RemoFirst', market: 'UA', aliases: ['ukraine', 'kyiv', 'kiev'] },
  { handle: 'binance', label: 'Binance', market: 'UA', aliases: ['ukraine', 'kyiv', 'kiev'] },
  { handle: 'remofirst', label: 'RemoFirst', market: 'UZ', aliases: ['uzbekistan', 'tashkent', 'toshkent'] },
  { provider: 'greenhouse', handle: 'exadelinc', label: 'Exadel', market: 'UZ', aliases: ['uzbekistan', 'tashkent', 'toshkent'] },
  { provider: 'greenhouse', handle: 'exadelinc', label: 'Exadel', market: 'RO', aliases: ['romania', 'bucharest'] },

  { handle: 'weloglobal', label: 'Welo Global', market: 'KG', aliases: ['kyrgyzstan', 'bishkek'] },
  { handle: 'binance', label: 'Binance', market: 'KG', aliases: ['kyrgyzstan', 'bishkek'] },

  { handle: 'xm', label: 'XM', market: 'KZ', aliases: ['kazakhstan', 'almaty', 'astana'] },
  { handle: 'aleph', label: 'Aleph', market: 'KZ', aliases: ['kazakhstan', 'almaty'] },
  { handle: 'creatio', label: 'Creatio', market: 'KZ', aliases: ['kazakhstan', 'almaty', 'astana'] },
  { handle: 'xsolla', label: 'Xsolla', market: 'KZ', aliases: ['kazakhstan', 'almaty', 'astana'] },
  { handle: 'binance', label: 'Binance', market: 'KZ', aliases: ['kazakhstan', 'almaty', 'astana'] },

  { handle: 'xsolla', label: 'Xsolla', market: 'CN', aliases: ['china', 'beijing', 'shanghai', 'shenzhen', 'dalian'] },
  { handle: 'shopback-2', label: 'ShopBack', market: 'CN', aliases: ['china', 'shenzhen', 'shanghai'] },
  { handle: 'Coda', label: 'Coda', market: 'CN', aliases: ['china', 'shanghai'] },
  { handle: 'dnb', label: 'Dun & Bradstreet', market: 'CN', aliases: ['china', 'shanghai', 'beijing'] },
  { handle: 'weloglobal', label: 'Welo Global', market: 'CN', aliases: ['china', 'beijing', 'shanghai', 'dalian'] },
  { handle: 'ppro', label: 'PPRO', market: 'CN', aliases: ['china', 'shanghai'] },

  { handle: 'cic', label: 'CIC', market: 'JP', aliases: ['japan', 'tokyo', 'fukuoka', 'jp'] },
  { handle: 'mendix', label: 'Mendix', market: 'JP', aliases: ['japan', 'tokyo'] },
  { handle: 'xsolla', label: 'Xsolla', market: 'JP', aliases: ['japan', 'tokyo'] },
  { handle: 'weloglobal', label: 'Welo Global', market: 'JP', aliases: ['japan', 'tokyo'] },
  { handle: 'binance', label: 'Binance', market: 'JP', aliases: ['japan', 'tokyo'] },
  { handle: 'EnvisionRPO', label: 'Envision RPO', market: 'JP', aliases: ['japan', 'tokyo'] },
  { handle: 'cagents', label: 'CAI', market: 'JP', aliases: ['japan', 'tokyo'] },

  // Korea includes both permanent commercial roles and remote contract work.
  { handle: 'xsolla', label: 'Xsolla', market: 'KR', aliases: ['south korea', 'seoul', 'korea'] },
  { handle: 'aleph', label: 'Aleph', market: 'KR', aliases: ['south korea', 'seoul'] },
  { handle: 'insiderone', label: 'Insider One', market: 'KR', aliases: ['south korea', 'seoul', 'korea'] },
  { handle: 'weloglobal', label: 'Welo Global', market: 'KR', aliases: ['south korea', 'seoul', 'korea'] },
  { handle: 'mistplay', label: 'Mistplay', market: 'KR', aliases: ['south korea', 'seoul', 'korea'] },
  { handle: 'rws', label: 'RWS TrainAI', market: 'KR', aliases: ['south korea', 'seoul', 'korea'] },

  // Canada: national/remote roles across product, customer, marketing, finance and engineering.
  { handle: 'pointclickcare', label: 'PointClickCare', market: 'CA', aliases: ['canada', 'remote- canada', 'remote - canada'] },
  { handle: 'applydigital', label: 'APPLY', market: 'CA', aliases: ['canada', 'remote - canada', 'remote canada'] },
  { handle: 'cscgeneration-2', label: 'CSC Generation', market: 'CA', aliases: ['canada', 'remote - canada', 'remote canada'] },

  // Cyprus: Limassol/Nicosia-heavy finance, operations, legal, risk, sales and tech.
  { handle: 'capital', label: 'Capital.com', market: 'CY', aliases: ['cyprus', 'limassol', 'nicosia'] },
  { handle: 'unlimit', label: 'Unlimit', market: 'CY', aliases: ['cyprus', 'limassol', 'nicosia'] },
  { handle: 'xsolla', label: 'Xsolla', market: 'CY', aliases: ['cyprus', 'limassol', 'nicosia'] },
  { handle: 'aleph', label: 'Aleph', market: 'CY', aliases: ['cyprus', 'limassol', 'nicosia'] },

  { handle: 'pointclickcare', label: 'PointClickCare', market: 'US', aliases: ['united states', 'remote - us', 'us remote', 'usa'] },
  { handle: 'atmosera', label: 'Atmosera', market: 'US', aliases: ['united states', 'remote - us', 'remote us', 'usa'] },
  { handle: 'entrata', label: 'Entrata', market: 'US', aliases: ['united states', 'remote - us', 'remote us', 'usa'] },
  { handle: 'Instrumentl', label: 'Instrumentl', market: 'US', aliases: ['united states', 'remote - usa', 'remote usa', 'usa'] },
  { handle: 'lwolf', label: 'Lone Wolf Technologies', market: 'US', aliases: ['united states', 'united states (remote)', 'remote - us', 'usa'] },
  { handle: 'deleteme', label: 'DeleteMe', market: 'US', aliases: ['united states', 'remote - us', 'remote us', 'usa'] },
  { handle: 'protective', label: 'Protective', market: 'US', aliases: ['united states', 'work from home', 'remote - us', 'usa'] },

  { handle: 'remofirst', label: 'RemoFirst', market: 'REMOTE', aliases: ['remote', 'worldwide', 'distributed'] },
  { handle: 'weloglobal', label: 'Welo Global', market: 'REMOTE', aliases: ['remote', 'worldwide', 'remote - europe'] },
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

type GreenhousePosting = {
  id?: number | string
  title?: string
  absolute_url?: string
  updated_at?: string
  content?: string
  location?: { name?: string }
  departments?: Array<{ name?: string }>
  offices?: Array<{ name?: string; location?: string }>
}

function stripHtml(value: unknown): string {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function targetMatchesLocation(location: string, target: RegionalBoardTarget): boolean {
  const normalized = location.toLocaleLowerCase('en')
  if (!normalized.trim()) return false
  return target.aliases.some((alias) => normalized.includes(alias.toLocaleLowerCase('en')))
}

function matchesLeverTarget(posting: LeverPosting, target: RegionalBoardTarget): boolean {
  const location = String(posting.categories?.location || '')
  const workplace = String(posting.workplaceType || '')
  return targetMatchesLocation(`${location} ${workplace}`, target)
}

export function mapExpandedLeverPostings(postings: LeverPosting[], target: RegionalBoardTarget): Job[] {
  return postings.flatMap((posting) => {
    if (!posting.text || !posting.hostedUrl || !matchesLeverTarget(posting, target)) return []

    const location = posting.categories?.location || (target.market === 'REMOTE' ? 'Remote' : target.market)
    const description = stripHtml(posting.descriptionPlain || posting.description).slice(0, 6000)
    const semanticText = `${posting.text} ${location} ${posting.workplaceType || ''} ${description}`

    return [{
      id: `companies-expanded-${target.market.toLowerCase()}-${posting.id || posting.hostedUrl}`,
      title: posting.text,
      company: target.label,
      location,
      url: posting.hostedUrl,
      source: 'companies' as const,
      remote: detectWorkModes(semanticText).includes('remote') || /remote/i.test(String(posting.workplaceType || '')),
      tags: [target.market, posting.categories?.team, posting.categories?.department]
        .filter((value): value is string => Boolean(value))
        .slice(0, 8),
      postedAt: new Date(posting.createdAt || Date.now()).toISOString(),
      employmentType: posting.categories?.commitment,
      description: description || undefined,
      employerType: 'direct' as const,
    }]
  })
}

export function mapExpandedGreenhousePostings(postings: GreenhousePosting[], target: RegionalBoardTarget): Job[] {
  return postings.flatMap((posting) => {
    const location = String(posting.location?.name || '')
    if (!posting.title || !posting.absolute_url || !targetMatchesLocation(location, target)) return []

    const description = stripHtml(posting.content).slice(0, 6000)
    const semanticText = `${posting.title} ${location} ${description}`
    return [{
      id: `companies-expanded-${target.market.toLowerCase()}-${posting.id || posting.absolute_url}`,
      title: posting.title,
      company: target.label,
      location: location || target.market,
      url: posting.absolute_url,
      source: 'companies' as const,
      remote: detectWorkModes(semanticText).includes('remote'),
      tags: [
        target.market,
        ...(posting.departments || []).map((item) => item.name).filter((value): value is string => Boolean(value)),
      ].slice(0, 8),
      postedAt: posting.updated_at && Number.isFinite(Date.parse(posting.updated_at))
        ? new Date(posting.updated_at).toISOString()
        : new Date().toISOString(),
      description: description || undefined,
      employerType: 'direct' as const,
    }]
  })
}

async function fetchLeverBoard(handle: string): Promise<LeverPosting[]> {
  const response = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(handle)}?mode=json`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`${handle} -> ${response.status}`)
  const postings = await response.json() as LeverPosting[]
  return Array.isArray(postings) ? postings : []
}

async function fetchGreenhouseBoard(handle: string): Promise<GreenhousePosting[]> {
  const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(handle)}/jobs?content=true`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`${handle} -> ${response.status}`)
  const body = await response.json() as { jobs?: GreenhousePosting[] }
  return Array.isArray(body.jobs) ? body.jobs : []
}

function boardKey(target: RegionalBoardTarget): string {
  return `${target.provider || 'lever'}:${target.handle}`
}

export const EXPANDED_REGIONAL_REMOTE_TARGET_PREFIX = 'expanded-regional-remote:'

export function configuredExpandedRegionalRemoteTargets(): string[] {
  if (String(process.env.EXPANDED_REGIONAL_REMOTE_SOURCE || 'on').toLowerCase() === 'off') return []
  return [...new Set(EXPANDED_REGIONAL_REMOTE_COMPANIES.map((target) =>
    `${EXPANDED_REGIONAL_REMOTE_TARGET_PREFIX}${boardKey(target)}`,
  ))]
}

export function isExpandedRegionalRemoteTarget(target: string): boolean {
  return target.startsWith(EXPANDED_REGIONAL_REMOTE_TARGET_PREFIX)
}

export async function fetchExpandedRegionalRemoteTarget(target: string): Promise<Job[]> {
  if (!isExpandedRegionalRemoteTarget(target)) throw new Error(`Unknown expanded regional target ${target}`)
  const key = target.slice(EXPANDED_REGIONAL_REMOTE_TARGET_PREFIX.length)
  const markets = EXPANDED_REGIONAL_REMOTE_COMPANIES.filter((candidate) => boardKey(candidate) === key)
  const board = markets[0]
  if (!board) throw new Error(`Unknown expanded regional target ${target}`)

  const provider = board.provider || 'lever'
  const postings = provider === 'greenhouse'
    ? await fetchGreenhouseBoard(board.handle)
    : await fetchLeverBoard(board.handle)
  const byUrl = new Map<string, Job>()

  for (const market of markets) {
    const jobs = provider === 'greenhouse'
      ? mapExpandedGreenhousePostings(postings as GreenhousePosting[], market)
      : mapExpandedLeverPostings(postings as LeverPosting[], market)
    for (const job of jobs) byUrl.set(job.url || job.id, job)
  }
  return [...byUrl.values()]
}
