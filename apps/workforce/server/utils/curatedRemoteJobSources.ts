import { parseHiringSourceSalary } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { parseHiringActivityDate } from '@whiteslove/parsing-lexicon/hiring-temporal'
import type { Job } from './jobTypes'
import { detectWorkModes } from './hiringLexicon'
import { absoluteHttpUrl, stripHtml } from './htmlText'

const MAX_DESCRIPTION = 4_000

export type RemoteBoardKey =
  | 'remote-co'
  | 'flexjobs'
  | 'simplyhired'
  | 'wellfound'
  | 'working-nomads'
  | 'jobspresso'
  | 'virtual-vocations'
  | 'skip-the-drive'

export type RemoteBoard = {
  key: RemoteBoardKey
  label: string
  listUrl: string
  remoteByDefault: boolean
  detailPath: (url: URL) => boolean
}

export const CURATED_REMOTE_BOARDS: RemoteBoard[] = [
  {
    key: 'remote-co',
    label: 'Remote.co',
    listUrl: 'https://remote.co/remote-jobs',
    remoteByDefault: true,
    detailPath: (url) => /^\/job-details\/[a-z0-9-]+\/?$/i.test(url.pathname),
  },
  {
    key: 'flexjobs',
    label: 'FlexJobs',
    listUrl: 'https://www.flexjobs.com/remote-jobs',
    remoteByDefault: true,
    detailPath: (url) => /^\/publicjobs\/[a-z0-9-]+\/?$/i.test(url.pathname),
  },
  {
    key: 'simplyhired',
    label: 'SimplyHired',
    listUrl: 'https://www.simplyhired.com/search?q=remote',
    remoteByDefault: false,
    detailPath: (url) => /^\/job\/[a-z0-9_-]+\/?$/i.test(url.pathname),
  },
  {
    key: 'wellfound',
    label: 'Wellfound',
    listUrl: 'https://wellfound.com/jobs',
    remoteByDefault: false,
    detailPath: (url) => /^\/jobs\/\d+-[^/]+\/?$/i.test(url.pathname),
  },
  {
    key: 'working-nomads',
    label: 'Working Nomads',
    listUrl: 'https://www.workingnomads.com/',
    remoteByDefault: true,
    detailPath: (url) => /\/jobs?\//i.test(url.pathname),
  },
  {
    key: 'jobspresso',
    label: 'Jobspresso',
    listUrl: 'https://jobspresso.co/remote-work/',
    remoteByDefault: true,
    detailPath: (url) => /^\/remote-work\/.+/i.test(url.pathname) && url.pathname !== '/remote-work/',
  },
  {
    key: 'virtual-vocations',
    label: 'Virtual Vocations',
    listUrl: 'https://www.virtualvocations.com/jobs',
    remoteByDefault: true,
    detailPath: (url) => /\/(?:job|jobs)\/[a-z0-9][a-z0-9_-]+\/?$/i.test(url.pathname),
  },
  {
    key: 'skip-the-drive',
    label: 'SkipTheDrive',
    listUrl: 'https://www.skipthedrive.com/',
    remoteByDefault: true,
    detailPath: (url) => /^\/job\/[^/]+\/?$/i.test(url.pathname),
  },
]

function absoluteUrl(raw: string, base: string): string | null {
  const url = absoluteHttpUrl(raw, base)
  return url?.startsWith('https://') ? url : null
}

function sourceToken(value: string): string {
  return value
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(-180)
}

function salaryFields(text: string): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency'> {
  const parsed = parseHiringSourceSalary(text)
  if (!parsed || (parsed.min == null && parsed.max == null) || !parsed.currency) return {}
  return {
    salaryMin: parsed.min ?? undefined,
    salaryMax: parsed.max ?? undefined,
    salaryCurrency: parsed.currency,
  }
}

function validDate(value: unknown, fallbackText = ''): string {
  const direct = Date.parse(String(value || ''))
  if (Number.isFinite(direct)) return new Date(direct).toISOString()
  return parseHiringActivityDate(fallbackText) || new Date().toISOString()
}

function makeBoardJob(input: {
  board: RemoteBoard
  title: string
  company?: string
  location?: string
  url: string
  description?: string
  postedAt?: string
  employmentType?: string
  tags?: string[]
}): Job | null {
  const title = stripHtml(input.title).slice(0, 240)
  if (title.length < 3) return null
  const description = stripHtml(input.description || '').slice(0, MAX_DESCRIPTION)
  const company = stripHtml(input.company || '') || input.board.label
  const location = stripHtml(input.location || '') || (input.board.remoteByDefault ? 'Remote' : 'See listing')
  const semanticText = `${title}\n${location}\n${description}`

  return {
    id: `companies-${input.board.key}-${sourceToken(input.url)}`,
    title,
    company: company.slice(0, 180),
    location: location.slice(0, 240),
    url: input.url,
    source: 'companies',
    remote: input.board.remoteByDefault || detectWorkModes(semanticText).includes('remote'),
    tags: [...new Set([input.board.label, 'Remote job board', ...(input.tags || [])])].slice(0, 8),
    postedAt: input.postedAt || new Date().toISOString(),
    employmentType: input.employmentType,
    description: description || undefined,
    employerType: 'board',
    ...salaryFields(semanticText),
  }
}

function jsonLdNodes(value: unknown): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes)
  if (typeof value !== 'object') return []
  const graph = (value as any)['@graph']
  return graph ? jsonLdNodes(graph) : [value]
}

function locationFromPosting(posting: any): string {
  const raw = Array.isArray(posting?.jobLocation)
    ? posting.jobLocation
    : posting?.jobLocation
      ? [posting.jobLocation]
      : []
  const values = raw
    .map((item: any) => item?.address || item)
    .map((address: any) => [
      address?.addressLocality,
      address?.addressRegion,
      address?.addressCountry?.name || address?.addressCountry,
    ].filter(Boolean).join(', '))
    .filter(Boolean)

  if (values.length) return [...new Set(values)].join('; ')
  return posting?.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''
}

function parseJsonLd(html: string, board: RemoteBoard): Job[] {
  const jobs: Job[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(html))) {
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1]!)
    } catch {
      continue
    }

    for (const node of jsonLdNodes(parsed)) {
      const type = node?.['@type']
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))
      if (!isJob || !node?.title) continue
      const url = absoluteUrl(String(node.url || node.sameAs || ''), board.listUrl)
      if (!url) continue

      const job = makeBoardJob({
        board,
        title: node.title,
        company: node?.hiringOrganization?.name,
        location: locationFromPosting(node),
        url,
        postedAt: validDate(node.datePosted, stripHtml(node.description)),
        description: node.description,
        employmentType: Array.isArray(node.employmentType) ? node.employmentType[0] : node.employmentType,
      })
      if (job) jobs.push(job)
    }
  }

  return jobs
}

function attributeField(fragment: string, field: 'company' | 'location'): string {
  const names = field === 'company'
    ? '(?:company|employer|hiring-organization)'
    : '(?:location|job-location)'
  const patterns = [
    new RegExp(`<[^>]+(?:class|data-testid|data-test|itemprop)=["'][^"']*${names}[^"']*["'][^>]*>([\\s\\S]{0,500}?)<\\/[^>]+>`, 'i'),
    new RegExp(`<[^>]+aria-label=["'][^"']*${field}[^"']*["'][^>]*>([\\s\\S]{0,500}?)<\\/[^>]+>`, 'i'),
  ]
  for (const re of patterns) {
    const value = stripHtml(fragment.match(re)?.[1])
    if (value && value.length <= 240) return value
  }
  return ''
}

function anchorTitle(value: string): string {
  return stripHtml(value)
    .replace(/^(?:view|see|read|apply)\s+(?:job|details?)\s*[:-]?\s*/i, '')
    .trim()
}

function parseAnchors(html: string, board: RemoteBoard, baseUrl = board.listUrl): Job[] {
  const anchors: Array<{ index: number; end: number; url: string; title: string }> = []
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(html))) {
    const href = absoluteUrl(match[1]!, baseUrl)
    if (!href) continue
    let parsed: URL
    try {
      parsed = new URL(href)
    } catch {
      continue
    }
    if (!board.detailPath(parsed)) continue
    const title = anchorTitle(match[2] || '')
    if (title.length < 3 || title.length > 240) continue
    if (/^(?:apply|save|details?|learn more|read more|next|previous)$/i.test(title)) continue
    anchors.push({ index: match.index, end: re.lastIndex, url: href, title })
  }

  const unique: typeof anchors = []
  const seen = new Set<string>()
  for (const anchor of anchors) {
    if (seen.has(anchor.url)) continue
    seen.add(anchor.url)
    unique.push(anchor)
  }

  return unique.map((anchor, index) => {
    const start = Math.max(0, anchor.index - 800)
    const end = unique[index + 1]?.index ?? Math.min(html.length, anchor.end + 3_500)
    const card = html.slice(start, end)
    const text = stripHtml(card)
    const postedAt = validDate(card.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1], text)
    return makeBoardJob({
      board,
      title: anchor.title,
      company: attributeField(card, 'company'),
      location: attributeField(card, 'location'),
      url: anchor.url,
      postedAt,
      description: text,
    })
  }).filter((job): job is Job => job !== null)
}

export function parseCuratedRemoteBoardHtml(html: string, key: RemoteBoardKey, baseUrl?: string): Job[] {
  const board = CURATED_REMOTE_BOARDS.find((item) => item.key === key)
  if (!board) return []
  const byUrl = new Map<string, Job>()
  for (const job of [...parseJsonLd(html, board), ...parseAnchors(html, board, baseUrl)]) byUrl.set(job.url, job)
  return [...byUrl.values()]
}

export type WorkingNomadsItem = {
  url?: string
  title?: string
  description?: string
  company_name?: string
  category_name?: string
  tags?: string | string[]
  location?: string
  pub_date?: string
}

export function parseWorkingNomadsItems(items: WorkingNomadsItem[]): Job[] {
  const board = CURATED_REMOTE_BOARDS.find((item) => item.key === 'working-nomads')!
  return items.flatMap((item) => {
    const url = absoluteUrl(String(item.url || ''), 'https://www.workingnomads.com/')
    if (!url || !item.title) return []
    const tags = Array.isArray(item.tags)
      ? item.tags
      : String(item.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean)
    const job = makeBoardJob({
      board,
      title: item.title,
      company: item.company_name,
      location: item.location || 'Remote',
      url,
      postedAt: validDate(item.pub_date, stripHtml(item.description)),
      description: item.description,
      tags: [item.category_name || '', ...tags].filter(Boolean),
    })
    return job ? [job] : []
  })
}
