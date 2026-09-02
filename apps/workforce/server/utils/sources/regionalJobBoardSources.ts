import { detectHiringLocationName } from '@whiteslove/parsing-lexicon/hiring-location-fields'
import { parseHiringSourceSalary } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { parseHiringActivityDate, parseHiringDayMonthDate } from '@whiteslove/parsing-lexicon/hiring-temporal'
import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'
import type { Job } from '~~/shared/contracts/jobs'
import { detectWorkModes } from '../hiring/hiringLexicon'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MAX_AGE_DAYS = 14
const MAX_DESCRIPTION = 4_000

type Country = 'UZ' | 'KZ' | 'KG' | 'RO'
interface Board {
  key: string
  label: string
  country: Country
  root: string
  pageUrl: (page: number) => string
  detailRe: RegExp
  activeCatalogue?: boolean
  synthetic?: 'newjob' | 'headings'
}

const BOARDS: Board[] = [
  {
    key: 'resume-uz-vacancies', label: 'Resume.uz', country: 'UZ',
    root: 'https://www.resume.uz/ru/vacancies',
    pageUrl: (page) => page === 1 ? 'https://www.resume.uz/ru/vacancies' : `https://www.resume.uz/ru/vacancies?page=${page}`,
    detailRe: /resume\.uz\/ru\/(?:vacancy|vacancies)\/(?!search(?:[/?#]|$))[^?#]+/i,
    activeCatalogue: true,
  },
  {
    key: 'enbek-kz-vacancies', label: 'Enbek.kz', country: 'KZ',
    root: 'https://www.enbek.kz/ru/search/vacancy',
    pageUrl: (page) => page === 1 ? 'https://www.enbek.kz/ru/search/vacancy' : `https://www.enbek.kz/ru/search/vacancy?page=${page}`,
    detailRe: /enbek\.kz\/ru\/vacancy\/[^?#]+~\d+/i,
  },
  {
    key: 'qsamruk-kz-vacancies', label: 'QSamruk.kz', country: 'KZ',
    root: 'https://qsamruk.kz/vacancy',
    pageUrl: (page) => page === 1 ? 'https://qsamruk.kz/vacancy' : `https://qsamruk.kz/vacancy?page=${page}`,
    detailRe: /qsamruk\.kz\/vacancy\/(?!$)[^?#]+/i,
  },
  {
    key: 'newjob-kg-vacancies', label: 'NewJob.kg', country: 'KG',
    root: 'https://newjob.kg/vacancies',
    pageUrl: (page) => page === 1 ? 'https://newjob.kg/vacancies' : `https://newjob.kg/vacancies?page=${page - 1}`,
    detailRe: /newjob\.kg\/(?:vacancy|vacancies)\/(?!$)[^?#]+/i,
    synthetic: 'newjob',
  },
  {
    key: 'ekyzmat-kg-vacancies', label: 'e-Kyzmat', country: 'KG',
    root: 'https://kyzmat.gov.kg/ru/vacancies',
    pageUrl: (page) => page === 1 ? 'https://kyzmat.gov.kg/ru/vacancies' : `https://kyzmat.gov.kg/ru/vacancies?page=${page}`,
    detailRe: /kyzmat\.gov\.kg\/ru\/vacanc(?:y|ies)\/(?!$)[^?#]+/i,
  },
  {
    key: 'ejobs-ro-vacancies', label: 'eJobs.ro', country: 'RO',
    root: 'https://www.ejobs.ro/locuri-de-munca',
    pageUrl: (page) => page === 1 ? 'https://www.ejobs.ro/locuri-de-munca' : `https://www.ejobs.ro/locuri-de-munca/pagina${page}`,
    detailRe: /ejobs\.ro\/(?:user\/locuri-de-munca|locuri-de-munca)\/[^?#]+/i,
  },
  {
    key: 'bestjobs-ro-vacancies', label: 'BestJobs', country: 'RO',
    root: 'https://www.bestjobs.eu/en/jobs',
    pageUrl: (page) => page === 1 ? 'https://www.bestjobs.eu/en/jobs' : `https://www.bestjobs.eu/en/jobs?page=${page}`,
    detailRe: /bestjobs\.eu\/en\/(?:job|jobs)\/(?!$)[^?#]+/i,
    activeCatalogue: true,
    synthetic: 'headings',
  },
  {
    key: 'hipo-ro-vacancies', label: 'Hipo.ro', country: 'RO',
    root: 'https://www.hipo.ro/locuri-de-munca/joburi',
    pageUrl: (page) => page === 1 ? 'https://www.hipo.ro/locuri-de-munca/joburi' : `https://www.hipo.ro/locuri-de-munca/joburi/${page}`,
    detailRe: /hipo\.ro\/locuri-de-munca\/locuri_de_munca\/(?!$)[^?#]+/i,
  },
]

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x'
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function htmlText(value: string): string {
  return decodeEntities(value)
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|article|section|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function absoluteUrl(raw: string, base: string): string {
  try {
    const url = new URL(decodeEntities(raw), base)
    url.hash = ''
    return url.toString()
  } catch {
    return base
  }
}

function stableToken(value: string): string {
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(36)
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en,ro,uk;q=0.8',
    },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

function recentDate(text: string): string | null {
  const value = parseHiringActivityDate(text) || parseHiringDayMonthDate(text)
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  if (time < Date.now() - MAX_AGE_DAYS * 86_400_000 || time > Date.now() + 48 * 60 * 60 * 1000) return null
  return new Date(time).toISOString()
}

function salary(text: string): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency'> {
  const parsed = parseHiringSourceSalary(text)
  if (!parsed || !parsed.currency || (parsed.min == null && parsed.max == null)) return {}
  return {
    salaryMin: parsed.min ?? undefined,
    salaryMax: parsed.max ?? undefined,
    salaryCurrency: parsed.currency,
  }
}

function fallbackLocation(country: Country): string {
  return ({ UZ: 'Uzbekistan', KZ: 'Kazakhstan', KG: 'Kyrgyzstan', RO: 'Romania' } as const)[country]
}

function looksNonVacancy(title: string, text: string): boolean {
  return /(?:career\s+event|eveniment|workshop|webinar|cv\s+clinic|top\s+talents|proiect\s+cariera|training\s+event)/iu.test(`${title} ${text}`)
}

function likelyCompany(lines: string[], title: string, label: string): string {
  const index = Math.max(0, lines.findIndex((line) => line === title || line.includes(title)))
  for (const line of lines.slice(index + 1, index + 7)) {
    if (!line || line.length > 160) continue
    if (/^(?:aplic|отклик|подать|детал|details|обновлено|опубликовано|data|salary|salariu|город|oras|график|опыт)/iu.test(line)) continue
    if (recentDate(line) || parseHiringSourceSalary(line)) continue
    return line.replace(/^@\s*/, '').trim()
  }
  return `${label} employer`
}

function makeBoardJob(board: Board, input: { title: string; text: string; url: string; postedAt?: string; company?: string }): Job | null {
  const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 240)
  if (title.length < 3 || looksNonVacancy(title, input.text)) return null
  const postedAt = input.postedAt || recentDate(input.text) || (board.activeCatalogue ? new Date().toISOString() : null)
  if (!postedAt) return null
  const lines = input.text.split('\n').map((line) => line.trim()).filter(Boolean)
  const company = input.company?.trim() || likelyCompany(lines, title, board.label)
  const location = detectHiringLocationName(input.text, board.country) || fallbackLocation(board.country)
  return {
    id: `companies-${board.key}-${stableToken(input.url)}`,
    title,
    company: company.slice(0, 180),
    location,
    url: input.url,
    source: 'companies',
    remote: detectWorkModes(input.text).includes('remote'),
    tags: [board.label, board.country],
    postedAt,
    description: input.text.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION) || undefined,
    country: board.country,
    city: detectHiringLocationName(input.text, board.country) || undefined,
    employerType: 'board',
    hiringKind: 'vacancy',
    ...salary(input.text),
  }
}

function anchorJobs(html: string, board: Board): Job[] {
  const anchors: Array<{ index: number; end: number; href: string; title: string }> = []
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const href = absoluteUrl(match[1]!, board.root)
    board.detailRe.lastIndex = 0
    if (!board.detailRe.test(href)) continue
    const title = htmlText(match[2]!)
    if (!title || title.length > 260 || /^(?:details?|vezi|aplic|отклик|подробнее)$/iu.test(title)) continue
    anchors.push({ index: match.index, end: re.lastIndex, href, title })
  }

  const byUrl = new Map<string, Job>()
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!
    const start = Math.max(0, anchor.index - 500)
    const end = anchors[index + 1]?.index ?? Math.min(html.length, anchor.end + 5_000)
    const text = htmlText(html.slice(start, end))
    const job = makeBoardJob(board, { title: anchor.title, text, url: anchor.href })
    if (job) byUrl.set(job.url, job)
  }
  return [...byUrl.values()]
}

function newJobFallback(html: string, board: Board, page: number): Job[] {
  const lines = htmlText(html).split('\n').map((line) => line.trim()).filter(Boolean)
  const jobs: Job[] = []
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^Обновлено:$/iu.test(lines[index] || '')) continue
    const stamp = lines[index + 1] || ''
    let roleIndex = index + 2
    while (roleIndex < lines.length && /^Обновлено:$/iu.test(lines[roleIndex] || '')) roleIndex += 2
    const title = lines[roleIndex] || ''
    const company = lines[roleIndex + 1] || ''
    const city = lines[roleIndex + 2] || ''
    if (!title || /^(?:сегодня|вчера|более\s+недели)/iu.test(title)) continue
    let end = roleIndex + 1
    while (end < lines.length && !/^Обновлено:$/iu.test(lines[end] || '') && end - index < 22) end += 1
    const text = lines.slice(index, end).join('\n')
    const postedAt = recentDate(`${stamp}\n${text}`)
    if (!postedAt) continue
    const token = stableToken(`${title}|${company}|${city}|${text}`)
    if (seen.has(token)) continue
    seen.add(token)
    const job = makeBoardJob(board, {
      title,
      company,
      text,
      postedAt,
      url: `${board.root}#vacancy=${page}-${token}`,
    })
    if (job) jobs.push(job)
  }
  return jobs
}

function headingFallback(html: string, board: Board, page: number): Job[] {
  const matches = [...html.matchAll(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/gi)]
  const jobs: Job[] = []
  const seen = new Set<string>()
  for (let index = 0; index < matches.length; index += 1) {
    const title = htmlText(matches[index]![1] || '')
    if (!title || title.length > 220 || /^(?:jobs?|joburi|search|candidat|filter)/iu.test(title)) continue
    const start = matches[index]!.index || 0
    const end = matches[index + 1]?.index ?? Math.min(html.length, start + 2_000)
    const text = htmlText(html.slice(start, end))
    const token = stableToken(`${title}|${text}`)
    if (seen.has(token)) continue
    seen.add(token)
    const job = makeBoardJob(board, {
      title,
      text,
      url: `${board.root}#vacancy=${page}-${token}`,
    })
    if (job) jobs.push(job)
  }
  return jobs
}

function parseBoardPage(html: string, board: Board, page: number): Job[] {
  let jobs = anchorJobs(html, board)
  if (!jobs.length && board.synthetic === 'newjob') jobs = newJobFallback(html, board, page)
  if (!jobs.length && board.synthetic === 'headings') jobs = headingFallback(html, board, page)
  return jobs
}

export const REGIONAL_JOB_BOARD_TARGET_PREFIX = 'regional-job-board:'

export function configuredRegionalJobBoardTargets(): string[] {
  if (process.env.REGIONAL_JOB_BOARDS_SOURCE === 'off') return []
  return BOARDS.map((board) => `${REGIONAL_JOB_BOARD_TARGET_PREFIX}${board.key}`)
}

export function isRegionalJobBoardTarget(target: string): boolean {
  return target.startsWith(REGIONAL_JOB_BOARD_TARGET_PREFIX)
}

function boardForTarget(target: string): Board | undefined {
  if (!isRegionalJobBoardTarget(target)) return undefined
  const key = target.slice(REGIONAL_JOB_BOARD_TARGET_PREFIX.length)
  return BOARDS.find((board) => board.key === key)
}

export async function fetchRegionalJobBoardTarget(target: string): Promise<Job[]> {
  const board = boardForTarget(target)
  if (!board) throw new Error(`Unknown regional job-board target ${target}`)

  const run = await crawlStandardJobBoard({
    key: `regional-board:${board.key}`,
    fetchPage: (page) => fetchHtml(board.pageUrl(page)),
    parsePage: (html, page) => parseBoardPage(html, board, page),
  })
  return run.jobs
}

export function regionalJobBoardKeys(): string[] {
  return BOARDS.map((board) => board.key)
}
