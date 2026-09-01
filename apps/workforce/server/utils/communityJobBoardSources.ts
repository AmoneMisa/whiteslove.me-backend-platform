import { parseHiringSourceSalary } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { parseHiringActivityDate } from '@whiteslove/parsing-lexicon/hiring-temporal'
import {
  crawlStandardCursorJobBoard,
  crawlStandardJobBoard,
  enrichStandardJobBoardDetails,
} from './cyclicJobBoardCrawler'
import { parseFlagmaVacancies, parseFlagmaVacancyDetail } from './extraPublicJobSources'
import { absoluteHttpUrl, stripHtml } from './htmlText'
import { detectWorkModes } from './hiringLexicon'
import type { Job } from './jobTypes'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const COMMUNITY_JOB_BOARD_TARGET_PREFIX = 'community-job-board:'

type CommunityBoard = {
  key: string
  label: string
  url: string
  country?: string
  remoteByDefault?: boolean
  directEmployer?: boolean
  allowExternalJobLinks?: boolean
  pageUrl?: (page: number) => string
  parsePage?: (html: string, board: CommunityBoard, pageUrl: string) => Job[]
  detailParse?: (html: string, summary: Job) => Job | null
}

function queryPage(base: string, page: number, parameter = 'page'): string {
  if (page <= 1) return base
  const url = new URL(base)
  url.searchParams.set(parameter, String(page))
  return url.toString()
}

function offsetPage(base: string, page: number, parameter: string, step: number): string {
  if (page <= 1) return base
  const url = new URL(base)
  url.searchParams.set(parameter, String((page - 1) * step))
  return url.toString()
}

function flagmaPage(base: string, page: number): string {
  if (page <= 1) return base
  return `${base.replace(/\/+$/, '')}/page-${page}/`
}

/**
 * Candidate-facing sources supplied for Job Finder that are not already owned
 * by a dedicated adapter. Every paginated board below is executed as its own
 * queue target and uses the shared cyclic crawler; there is no board-local
 * fan-out, concurrency pool, timeout policy or per-run item cap here.
 */
export const COMMUNITY_JOB_BOARDS: CommunityBoard[] = [
  // Regional boards with source-specific deterministic parsers
  {
    key: 'flagma-ro',
    label: 'Flagma RO',
    url: 'https://flagma.ro/ru/vacancies/',
    country: 'RO',
    pageUrl: (page) => flagmaPage('https://flagma.ro/ru/vacancies/', page),
    parsePage: (html, board) => parseFlagmaVacancies(html, board),
    detailParse: parseFlagmaVacancyDetail,
  },
  {
    key: 'flagma-uz',
    label: 'Flagma UZ',
    url: 'https://flagma.uz/ru/vacancies/',
    country: 'UZ',
    pageUrl: (page) => flagmaPage('https://flagma.uz/ru/vacancies/', page),
    parsePage: (html, board) => parseFlagmaVacancies(html, board),
    detailParse: parseFlagmaVacancyDetail,
  },

  // General boards
  { key: 'indeed', label: 'Indeed', url: 'https://www.indeed.com/jobs', pageUrl: (page) => offsetPage('https://www.indeed.com/jobs', page, 'start', 10) },
  { key: 'glassdoor', label: 'Glassdoor', url: 'https://www.glassdoor.com/Job/jobs.htm' },
  { key: 'careerjet', label: 'Careerjet', url: 'https://www.careerjet.com/jobs' },
  { key: 'ziprecruiter', label: 'ZipRecruiter', url: 'https://www.ziprecruiter.com/jobs-search' },
  { key: 'monster', label: 'Monster', url: 'https://www.monster.com/jobs/search' },
  { key: 'talent-com', label: 'Talent.com', url: 'https://www.talent.com/jobs' },
  { key: 'careerbuilder', label: 'CareerBuilder', url: 'https://www.careerbuilder.com/jobs' },
  { key: 'jora', label: 'Jora', url: 'https://www.jora.com/jobs' },
  { key: 'jobisjob', label: 'JobisJob', url: 'https://www.jobisjob.com/' },
  { key: 'getwork', label: 'Getwork', url: 'https://www.getwork.com/jobs' },
  { key: 'lensa', label: 'Lensa', url: 'https://lensa.com/jobs' },

  // Remote-first boards
  { key: 'we-work-remotely', label: 'We Work Remotely', url: 'https://weworkremotely.com/', remoteByDefault: true },
  { key: 'dynamite-jobs', label: 'Dynamite Jobs', url: 'https://dynamitejobs.com/', remoteByDefault: true },
  { key: 'justremote', label: 'JustRemote', url: 'https://justremote.co/remote-jobs', remoteByDefault: true },
  { key: 'remotehub', label: 'RemoteHub', url: 'https://www.remotehub.com/jobs', remoteByDefault: true },
  { key: 'remote4me', label: 'Remote4Me', url: 'https://remote4.me/', remoteByDefault: true },
  { key: 'dailyremote', label: 'DailyRemote', url: 'https://dailyremote.com/', remoteByDefault: true },
  { key: 'remote-com', label: 'Remote', url: 'https://remote.com/jobs', remoteByDefault: true },
  { key: 'remote-jobs', label: 'Remote Jobs', url: 'https://remotejobs.com/', remoteByDefault: true },
  { key: 'workew', label: 'Workew', url: 'https://workew.com/', remoteByDefault: true },
  { key: 'nodesk', label: 'NoDesk', url: 'https://nodesk.co/remote-jobs/', remoteByDefault: true },
  { key: 'pangian', label: 'Pangian', url: 'https://pangian.com/job-travel-remote/', remoteByDefault: true },
  { key: 'rocketship', label: 'Rocketship Jobs', url: 'https://www.rocketshipjobs.com/', remoteByDefault: true },
  { key: 'jobgether', label: 'Jobgether', url: 'https://jobgether.com/remote-jobs', remoteByDefault: true },
  { key: 'hiring-cafe', label: 'HiringCafe', url: 'https://hiring.cafe/' },
  { key: 'remotejobfor-me', label: 'remotejobfor.me', url: 'https://remotejobfor.me/jobs', remoteByDefault: true },
  { key: 'sydicom', label: 'sydicom.app', url: 'https://sydicom.app/jobs', remoteByDefault: true },

  // Developer / IT networks
  { key: 'turing', label: 'Turing', url: 'https://www.turing.com/jobs', remoteByDefault: true },
  { key: 'arc-dev', label: 'Arc.dev', url: 'https://arc.dev/remote-jobs', remoteByDefault: true },
  { key: 'crossover', label: 'Crossover', url: 'https://www.crossover.com/jobs', remoteByDefault: true },
  { key: 'gun-io', label: 'Gun.io', url: 'https://gun.io/find-work/', remoteByDefault: true },
  { key: 'landing-jobs', label: 'Landing.Jobs', url: 'https://landing.jobs/jobs' },
  { key: 'offerzen', label: 'OfferZen', url: 'https://www.offerzen.com/job-seekers' },
  { key: 'devitjobs', label: 'DevITJobs', url: 'https://devitjobs.com/' },
  { key: 'js-remotely', label: 'JS Remotely', url: 'https://jsremotely.com/', remoteByDefault: true },
  { key: 'golang-cafe', label: 'Golang Cafe', url: 'https://golang.cafe/', remoteByDefault: true },
  { key: 'python-jobs', label: 'Python Jobs', url: 'https://www.python.org/jobs/' },
  { key: 'rubynow', label: 'RubyNow', url: 'https://rubynow.com/' },
  { key: 'ai-jobs', label: 'AI Jobs', url: 'https://aijobs.net/' },

  // Freelance / project marketplaces
  { key: 'upwork', label: 'Upwork', url: 'https://www.upwork.com/nx/search/jobs/' },
  { key: 'fiverr', label: 'Fiverr', url: 'https://www.fiverr.com/categories/programming-tech' },
  { key: 'freelancer', label: 'Freelancer', url: 'https://www.freelancer.com/jobs/' },
  { key: 'toptal', label: 'Toptal', url: 'https://www.toptal.com/talent/apply' },
  { key: 'braintrust', label: 'Braintrust', url: 'https://app.usebraintrust.com/jobs/' },
  { key: 'contra', label: 'Contra', url: 'https://contra.com/opportunities' },
  { key: 'guru', label: 'Guru', url: 'https://www.guru.com/d/jobs/' },
  { key: 'peopleperhour', label: 'PeoplePerHour', url: 'https://www.peopleperhour.com/freelance-jobs' },
  { key: 'workana', label: 'Workana', url: 'https://www.workana.com/jobs' },
  { key: 'truelancer', label: 'Truelancer', url: 'https://www.truelancer.com/freelance-jobs' },
  { key: 'hubstaff-talent', label: 'Hubstaff Talent', url: 'https://talent.hubstaff.com/search/jobs' },
  { key: 'solidgigs', label: 'SolidGigs', url: 'https://solidgigs.com/' },
  { key: 'catalant', label: 'Catalant', url: 'https://gocatalant.com/experts/' },
  { key: 'cloudpeeps', label: 'CloudPeeps', url: 'https://www.cloudpeeps.com/jobs' },
  { key: 'kolabtree', label: 'Kolabtree', url: 'https://www.kolabtree.com/projects' },
  { key: 'bark', label: 'Bark', url: 'https://www.bark.com/en/us/find-a-professional/' },

  // Design / creative
  { key: 'dribbble', label: 'Dribbble Jobs', url: 'https://dribbble.com/jobs' },
  { key: 'behance', label: 'Behance Jobs', url: 'https://www.behance.net/joblist' },
  { key: 'krop', label: 'Krop', url: 'https://www.krop.com/creative-jobs/' },
  { key: 'coroflot', label: 'Coroflot', url: 'https://www.coroflot.com/design-jobs' },
  { key: 'design-jobs-board', label: 'Design Jobs Board', url: 'https://www.designjobsboard.com/' },
  { key: 'working-not-working', label: 'Working Not Working', url: 'https://workingnotworking.com/jobs' },
  { key: 'creativepool', label: 'Creativepool', url: 'https://creativepool.com/jobs' },
  { key: 'designcrowd', label: 'DesignCrowd', url: 'https://www.designcrowd.com/jobs' },

  // Writing / marketing / content
  { key: 'problogger', label: 'ProBlogger Jobs', url: 'https://problogger.com/jobs/' },
  { key: 'freelance-writing', label: 'Freelance Writing Jobs', url: 'https://www.freelancewriting.com/jobs/' },
  { key: 'contena', label: 'Contena', url: 'https://contena.co/' },
  { key: 'bloggingpro', label: 'BloggingPro', url: 'https://www.bloggingpro.com/jobs/' },
  { key: 'writeraccess', label: 'WriterAccess', url: 'https://www.writeraccess.com/apply/' },
  { key: 'clearvoice', label: 'ClearVoice', url: 'https://www.clearvoice.com/talent-network/' },
  { key: 'marketerhire', label: 'MarketerHire', url: 'https://marketerhire.com/marketers' },
  { key: 'mediabistro', label: 'Mediabistro', url: 'https://www.mediabistro.com/jobs/' },
  { key: 'superpath', label: 'Superpath Jobs', url: 'https://www.superpath.co/jobs' },

  // Translation / teaching
  { key: 'proz', label: 'ProZ', url: 'https://www.proz.com/translation-jobs' },
  { key: 'translators-cafe', label: 'TranslatorsCafe', url: 'https://www.translatorscafe.com/cafe/searchjobs.asp' },
  { key: 'gengo', label: 'Gengo', url: 'https://gengo.com/translators/' },
  { key: 'smartcat', label: 'Smartcat', url: 'https://www.smartcat.com/marketplace/' },
  { key: 'preply', label: 'Preply', url: 'https://preply.com/en/teach' },
  { key: 'italki', label: 'italki', url: 'https://teach.italki.com/' },
  { key: 'cambly', label: 'Cambly', url: 'https://www.cambly.com/english/tutors?lang=en' },

  // Support / virtual assistants
  { key: 'modsquad', label: 'ModSquad', url: 'https://modsquad.com/careers/' },
  { key: 'support-adventure', label: 'Support Adventure', url: 'https://www.supportadventure.com/careers/', remoteByDefault: true },
  { key: 'working-solutions', label: 'Working Solutions', url: 'https://jobs.workingsolutions.com/', remoteByDefault: true },
  { key: 'belay', label: 'BELAY', url: 'https://belaysolutions.com/jobs/', remoteByDefault: true },
  { key: 'time-etc', label: 'Time Etc', url: 'https://web.timeetc.com/be-a-virtual-assistant/', remoteByDefault: true },

  // Direct employers from the relocation list supplied with the same source batch
  { key: 'airbus', label: 'Airbus', url: 'https://www.airbus.com/en/careers', directEmployer: true, allowExternalJobLinks: true },
  { key: 'siemens', label: 'Siemens', url: 'https://jobs.siemens.com/careers', directEmployer: true, allowExternalJobLinks: true },
  { key: 'quantco', label: 'QuantCo', url: 'https://jobs.lever.co/quantco-', directEmployer: true },
  { key: 'wypoon', label: 'Wypoon Technologies', url: 'https://jobs.lever.co/wypoon', directEmployer: true },
  { key: 'neworbit', label: 'NewOrbit Space', url: 'https://neworbit.space/careers', directEmployer: true, allowExternalJobLinks: true },
  { key: 'sunrise-greenhouse', label: 'Sunrise Group', url: 'https://job-boards.greenhouse.io/sunriseunitedstatesinc', directEmployer: true },
]

const HIMALAYAS_KEY = 'himalayas'

function targetName(key: string): string {
  return `${COMMUNITY_JOB_BOARD_TARGET_PREFIX}${key}`
}

export function configuredCommunityJobBoardTargets(): string[] {
  return [...COMMUNITY_JOB_BOARDS.map((board) => targetName(board.key)), targetName(HIMALAYAS_KEY)]
}

export function isCommunityJobBoardTarget(target: string): boolean {
  return target.startsWith(COMMUNITY_JOB_BOARD_TARGET_PREFIX)
}

function targetKey(target: string): string {
  return target.slice(COMMUNITY_JOB_BOARD_TARGET_PREFIX.length)
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
  if (!parsed || !parsed.currency || (parsed.min == null && parsed.max == null)) return {}
  return {
    salaryMin: parsed.min ?? undefined,
    salaryMax: parsed.max ?? undefined,
    salaryCurrency: parsed.currency,
  }
}

function postedAt(value: unknown, fallbackText = ''): string {
  const direct = Date.parse(String(value || ''))
  if (Number.isFinite(direct)) return new Date(direct).toISOString()
  return parseHiringActivityDate(fallbackText) || new Date().toISOString()
}

function sameHostFamily(candidate: URL, base: URL): boolean {
  return candidate.hostname === base.hostname
    || candidate.hostname.endsWith(`.${base.hostname}`)
    || base.hostname.endsWith(`.${candidate.hostname}`)
}

function looksLikeJobUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase().replace(/\/+$/, '')
  if (!path || path === '/') return false
  if (/\/(?:login|signin|signup|register|pricing|employers?|companies|categories|search)(?:\/|$)/.test(path)) return false
  if (url.hostname === 'jobs.lever.co') return path.split('/').filter(Boolean).length >= 2
  if (url.hostname === 'job-boards.greenhouse.io') return /\/jobs\/\d+$/i.test(path)

  return /\/(?:remote-)?jobs?\/[a-z0-9][^/]{1,}/i.test(path)
    || /\/(?:vacanc(?:y|ies)|positions?|openings?|opportunities|offers?|projects?)\/[a-z0-9][^/]{1,}/i.test(path)
    || /\/job(?:ad)?[-_/][a-z0-9][a-z0-9_-]{3,}/i.test(path)
}

function jsonLdNodes(value: unknown): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes)
  if (typeof value !== 'object') return []
  const graph = (value as any)['@graph']
  return graph ? jsonLdNodes(graph) : [value]
}

function locationFromPosting(posting: any, board: CommunityBoard): string {
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
  if (posting?.jobLocationType === 'TELECOMMUTE' || board.remoteByDefault) return 'Remote'
  return 'See listing'
}

function makeJob(input: {
  board: CommunityBoard
  title: string
  company?: string
  location?: string
  url: string
  description?: string
  date?: unknown
  employmentType?: string
}): Job | null {
  const title = stripHtml(input.title).replace(/\s+/g, ' ').trim().slice(0, 240)
  if (title.length < 3) return null
  const description = stripHtml(input.description || '').slice(0, 4_000)
  const location = stripHtml(input.location || '') || (input.board.remoteByDefault ? 'Remote' : 'See listing')
  const semanticText = `${title}\n${location}\n${description}`

  return {
    id: `companies-community-${input.board.key}-${sourceToken(input.url)}`,
    title,
    company: (stripHtml(input.company || '') || input.board.label).slice(0, 180),
    location: location.slice(0, 240),
    url: input.url,
    source: 'companies',
    remote: input.board.remoteByDefault === true || detectWorkModes(semanticText).includes('remote'),
    tags: [input.board.label],
    postedAt: postedAt(input.date, semanticText),
    employmentType: input.employmentType,
    description: description || undefined,
    employerType: input.board.directEmployer ? 'direct' : 'board',
    ...salaryFields(semanticText),
  }
}

function parseJsonLd(html: string, board: CommunityBoard): Job[] {
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
      const url = absoluteHttpUrl(String(node.url || node.sameAs || ''), board.url)
      if (!url) continue
      const job = makeJob({
        board,
        title: node.title,
        company: node?.hiringOrganization?.name,
        location: locationFromPosting(node, board),
        url,
        description: node.description,
        date: node.datePosted,
        employmentType: Array.isArray(node.employmentType) ? node.employmentType[0] : node.employmentType,
      })
      if (job) jobs.push(job)
    }
  }

  return jobs
}

function parseAnchors(html: string, board: CommunityBoard, baseUrl: string): Job[] {
  const base = new URL(baseUrl)
  const anchors: Array<{ index: number; end: number; url: string; title: string }> = []
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(html))) {
    const href = absoluteHttpUrl(match[1]!, baseUrl)
    if (!href) continue
    let parsed: URL
    try {
      parsed = new URL(href)
    } catch {
      continue
    }
    if (!board.allowExternalJobLinks && !sameHostFamily(parsed, base)) continue
    if (!looksLikeJobUrl(parsed)) continue

    const title = stripHtml(match[2] || '').replace(/\s+/g, ' ').trim()
    if (title.length < 3 || title.length > 220) continue
    if (/^(?:apply|apply now|view|view job|details?|read more|learn more|save|next|previous)$/i.test(title)) continue
    anchors.push({ index: match.index, end: re.lastIndex, url: href, title })
  }

  const byUrl = new Map<string, Job>()
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!
    if (byUrl.has(anchor.url)) continue
    const start = Math.max(0, anchor.index - 600)
    const end = anchors[index + 1]?.index ?? Math.min(html.length, anchor.end + 2_000)
    const card = html.slice(start, end)
    const text = stripHtml(card).slice(0, 4_000)
    const timeValue = card.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1]
    const company = stripHtml(
      card.match(/<[^>]+(?:class|data-testid|itemprop)=["'][^"']*(?:company|employer|hiring-organization)[^"']*["'][^>]*>([\s\S]{0,400}?)<\/[^>]+>/i)?.[1] || '',
    )
    const location = stripHtml(
      card.match(/<[^>]+(?:class|data-testid|itemprop)=["'][^"']*(?:location|job-location)[^"']*["'][^>]*>([\s\S]{0,400}?)<\/[^>]+>/i)?.[1] || '',
    )
    const job = makeJob({
      board,
      title: anchor.title,
      company: board.directEmployer ? board.label : company,
      location,
      url: anchor.url,
      description: text,
      date: timeValue,
    })
    if (job) byUrl.set(job.url, job)
  }
  return [...byUrl.values()]
}

function parseBoardPage(html: string, board: CommunityBoard, baseUrl: string): Job[] {
  const byUrl = new Map<string, Job>()
  for (const job of [...parseJsonLd(html, board), ...parseAnchors(html, board, baseUrl)]) {
    byUrl.set(job.url, job)
  }
  return [...byUrl.values()]
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

async function crawlBoard(board: CommunityBoard): Promise<Job[]> {
  const run = await crawlStandardJobBoard({
    key: `community:${board.key}`,
    fetchPage: async (page) => {
      const url = board.pageUrl ? board.pageUrl(page) : queryPage(board.url, page)
      return fetchText(url)
    },
    parsePage: (html, page) => {
      const url = board.pageUrl ? board.pageUrl(page) : queryPage(board.url, page)
      return board.parsePage ? board.parsePage(html, board, url) : parseBoardPage(html, board, url)
    },
  })

  const jobs = board.detailParse
    ? await enrichStandardJobBoardDetails({
        key: `community:${board.key}`,
        jobs: run.jobs,
        fetchDetail: (job) => fetchText(job.url),
        parseDetail: board.detailParse,
      })
    : run.jobs

  console.log(
    `[jobs] ${board.label} pages=${run.pages.join(',')} next=${run.nextPage} cycle=${run.cycle}`,
  )
  return jobs
}

type HimalayasJob = {
  title?: string
  excerpt?: string
  companyName?: string
  employmentType?: string
  minSalary?: number | null
  maxSalary?: number | null
  salaryPeriod?: string | null
  currency?: string | null
  locationRestrictions?: string[] | null
  categories?: string[] | null
  parentCategories?: string[] | null
  description?: string
  pubDate?: number | string
  applicationLink?: string
  guid?: string
}

type HimalayasResponse = {
  nextCursor?: string
  jobs?: HimalayasJob[]
}

function parseHimalayas(raw: string): Job[] {
  const data = JSON.parse(raw) as HimalayasResponse
  const board: CommunityBoard = {
    key: HIMALAYAS_KEY,
    label: 'Himalayas',
    url: 'https://himalayas.app/jobs',
    remoteByDefault: true,
  }

  return (data.jobs || []).flatMap((item) => {
    if (!item.title) return []
    const rawUrl = item.applicationLink || item.guid || ''
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : ''
    if (!url) return []
    const location = item.locationRestrictions?.length
      ? item.locationRestrictions.join('; ')
      : 'Remote / Worldwide'
    const job = makeJob({
      board,
      title: item.title,
      company: item.companyName,
      location,
      url,
      description: item.description || item.excerpt,
      date: item.pubDate,
      employmentType: item.employmentType,
    })
    if (!job) return []
    job.salaryMin = item.minSalary ?? job.salaryMin
    job.salaryMax = item.maxSalary ?? job.salaryMax
    job.salaryCurrency = item.currency || job.salaryCurrency
    return [job]
  })
}

async function crawlHimalayas(): Promise<Job[]> {
  const run = await crawlStandardCursorJobBoard({
    key: 'community:himalayas',
    fetchPage: async (cursor) => {
      const url = new URL('https://himalayas.app/jobs/api')
      url.searchParams.set('limit', '20')
      if (cursor) url.searchParams.set('cursor', cursor)
      return fetchText(url.toString())
    },
    parsePage: (raw) => parseHimalayas(raw),
    nextCursor: (raw) => {
      const data = JSON.parse(raw) as HimalayasResponse
      return typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null
    },
  })
  console.log(
    `[jobs] Himalayas cursors=${run.cursors.length} cycle=${run.cycle} reachedEnd=${run.reachedEnd}`,
  )
  return run.jobs
}

export async function fetchCommunityJobBoardTarget(target: string): Promise<Job[]> {
  if (!isCommunityJobBoardTarget(target)) throw new Error(`Unknown community job-board target ${target}`)
  const key = targetKey(target)
  if (key === HIMALAYAS_KEY) return crawlHimalayas()
  const board = COMMUNITY_JOB_BOARDS.find((item) => item.key === key)
  if (!board) throw new Error(`Unknown community job board ${key}`)
  return crawlBoard(board)
}
