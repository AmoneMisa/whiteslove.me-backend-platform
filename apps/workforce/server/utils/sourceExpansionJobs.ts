import { detectCountryCodeFromText } from '@whiteslove/parsing-lexicon/geography-detection'
import { geographyDisplayName } from '@whiteslove/parsing-lexicon/geography-display'
import { detectHiringLocationName } from '@whiteslove/parsing-lexicon/hiring-location-fields'
import { parseHiringSourceSalary } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { parseHiringActivityDate } from '@whiteslove/parsing-lexicon/hiring-temporal'
import {
  crawlStandardJobBoard,
  enrichStandardJobBoardDetails,
} from './cyclicJobBoardCrawler'
import type { Job } from '~~/shared/contracts/jobs'
import { detectWorkModes } from './hiringLexicon'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const MAX_AGE_DAYS = 14
const MAX_DESCRIPTION = 4_000

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  }
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x'
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function stripHtml(value: unknown): string {
  return decodeEntities(String(value || ''))
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlLines(value: string): string[] {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|article|section|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
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

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

async function fetchJsonText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

function jobId(label: string, url: string): string {
  const token = url.replace(/^https?:\/\//i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(-180)
  return `companies-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${token}`
}

function isRecent(date: string | null | undefined): boolean {
  if (!date) return false
  const time = Date.parse(date)
  return Number.isFinite(time)
    && time >= Date.now() - MAX_AGE_DAYS * 86_400_000
    && time <= Date.now() + 48 * 60 * 60 * 1000
}

function salary(text: string): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency'> {
  const parsed = parseHiringSourceSalary(text)
  if (!parsed || (parsed.min == null && parsed.max == null) || !parsed.currency) return {}
  return {
    salaryMin: parsed.min ?? undefined,
    salaryMax: parsed.max ?? undefined,
    salaryCurrency: parsed.currency,
  }
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
  employerType?: 'direct' | 'board'
}): Job {
  return {
    id: jobId(input.label, input.url),
    title: stripHtml(input.title).slice(0, 240),
    company: stripHtml(input.company || input.label).slice(0, 180),
    location: stripHtml(input.location || 'See listing').slice(0, 240),
    url: input.url,
    source: 'companies',
    remote: detectWorkModes(`${input.title} ${input.location} ${input.description || ''}`).includes('remote'),
    tags: [...new Set([input.label, ...(input.tags || [])])].slice(0, 8),
    postedAt: input.postedAt || new Date().toISOString(),
    employmentType: input.employmentType,
    description: stripHtml(input.description || '').slice(0, MAX_DESCRIPTION) || undefined,
    employerType: input.employerType || 'direct',
    ...salary(`${input.title} ${input.description || ''}`),
  }
}

const ISHKOP_CITY_ROUTES = [
  ['tashkent', 'Tashkent', 'Ташкент'],
  ['samarkand', 'Samarkand', 'Самарканд'],
  ['bukhara', 'Bukhara', 'Бухара'],
  ['fergana', 'Fergana', 'Фергана'],
  ['andijan', 'Andijan', 'Андижан'],
  ['namangan', 'Namangan', 'Наманган'],
  ['nukus', 'Nukus', 'Нукус'],
  ['navoi', 'Navoi', 'Навои'],
  ['urgench', 'Urgench', 'Ургенч'],
  ['qarshi', 'Qarshi', 'Карши'],
] as const

function likelyCompany(lines: string[], title: string): string {
  const index = lines.findIndex((line) => line === title || line.includes(title))
  for (const line of lines.slice(Math.max(0, index + 1), Math.max(0, index + 5))) {
    if (line.length < 2 || line.length > 120) continue
    if (/UZS|USD|сум/iu.test(line) || parseHiringActivityDate(line) || detectHiringLocationName(line, 'UZ')) continue
    if (/^(?:обязанности|требования|условия|скрыть|вакансия скрыта)/iu.test(line)) continue
    return line
  }
  return 'Ishkop employer'
}

function parseIshkopPage(html: string, location: string): Job[] {
  const base = 'https://ishkop.uz/'
  const matches = [...html.matchAll(/<a\b[^>]*href=["']([^"']*jobdesc\?[^"']*\bid=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
  const out: Job[] = []

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const title = stripHtml(match[2])
    if (title.length < 3 || title.length > 240) continue
    const start = match.index || 0
    const end = matches[i + 1]?.index ?? Math.min(html.length, start + 8_000)
    const block = html.slice(start, end)
    const text = htmlLines(block).join('\n')
    const postedAt = parseHiringActivityDate(text)
    if (!isRecent(postedAt)) continue
    const url = absoluteUrl(match[1]!, base)
    const lines = htmlLines(block)
    const detectedLocation = lines.find((line) => Boolean(detectHiringLocationName(line, 'UZ'))) || `${location}, Uzbekistan`

    out.push({
      ...makeJob({
        label: 'Ishkop.uz',
        title,
        company: likelyCompany(lines, title),
        location: detectedLocation,
        url,
        postedAt: postedAt!,
        description: text,
        tags: ['Uzbekistan', location],
        employerType: 'board',
      }),
      ...salary(text),
    })
  }
  return out
}

function ishkopClassBlock(html: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html.match(
    new RegExp(`<([a-z0-9]+)[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'iu'),
  )?.[2] || ''
}

export function parseIshkopVacancyDetail(html: string, fallbackUrl: string): Job | null {
  const title = stripHtml(
    html.match(/<div\b[^>]*class=["'][^"']*\btitle-wrap\b[^"']*["'][^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1],
  )
  if (!title || title.length > 240) return null

  const company = stripHtml(ishkopClassBlock(html, 'company-wrap')) || 'Ishkop employer'
  const location = stripHtml(
    html.match(/<span\b[^>]*id=["']spnLocation["'][^>]*>([\s\S]*?)<\/span>/iu)?.[1],
  ) || 'Uzbekistan'
  const description = htmlLines(
    html.match(
      /<div\b[^>]*class=["'][^"']*\bsection-title\b[^"']*["'][^>]*>\s*Описание вакансии\s*<\/div>\s*<div\b[^>]*class=["'][^"']*\btext\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class=["'][^"']*\bsection-title\b/iu,
    )?.[1] || '',
  ).join('\n')
  if (description.length < 40) return null

  const employmentType = stripHtml(
    html.match(/<td\b[^>]*class=["'][^"']*\bname\b[^"']*\bjobtype\b[^"']*["'][^>]*>[\s\S]*?<\/td>\s*<td\b[^>]*class=["'][^"']*\bvalue\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/iu)?.[1],
  ) || undefined
  const addedText = stripHtml(
    html.match(/<div\b[^>]*class=["'][^"']*\bsource\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)?.[1],
  )
  const postedAt = parseHiringActivityDate(addedText) || undefined
  const canonicalUrl = html.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["'][^>]*>/iu)?.[1]

  return makeJob({
    label: 'Ishkop.uz',
    title,
    company,
    location,
    url: canonicalUrl ? absoluteUrl(canonicalUrl, fallbackUrl) : fallbackUrl,
    postedAt,
    description,
    employmentType,
    tags: ['Uzbekistan'],
    employerType: 'board',
  })
}

interface IshBorSummary { url: string; title: string; text: string }

function ishBorSummaries(html: string): IshBorSummary[] {
  const base = 'https://ish-bor.uz/ru/ishlar'
  const matches = [...html.matchAll(/<a\b[^>]*href=["']([^"']*\/ru\/ishlar\/id\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
  const unique = new Map<string, IshBorSummary>()
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const title = stripHtml(match[2])
    if (title.length < 2 || /подробнее/iu.test(title)) continue
    const start = match.index || 0
    const end = matches[i + 1]?.index ?? Math.min(html.length, start + 4_000)
    const url = absoluteUrl(match[1]!, base)
    unique.set(url, { url, title, text: htmlLines(html.slice(start, end)).join('\n') })
  }
  return [...unique.values()]
}

function parseIshBorPage(html: string): Job[] {
  return ishBorSummaries(html).map((summary) => {
    const lines = summary.text.split('\n').filter(Boolean)
    const location = lines.find((line) => Boolean(detectHiringLocationName(line, 'UZ'))) || 'Uzbekistan'
    return {
      ...makeJob({
        label: 'ish-bor.uz',
        title: summary.title,
        company: 'ish-bor.uz employer',
        location,
        url: summary.url,
        description: summary.text,
        tags: ['Uzbekistan'],
        employerType: 'board',
      }),
      ...salary(summary.text),
    }
  })
}

function parseIshBorDetail(html: string, summary: Job): Job | null {
  const detailText = htmlLines(html).join('\n')
  const postedAt = parseHiringActivityDate(detailText)
  if (postedAt && !isRecent(postedAt)) return null
  return {
    ...summary,
    postedAt: postedAt || summary.postedAt,
    description: stripHtml(detailText).slice(0, MAX_DESCRIPTION) || summary.description,
    ...salary(`${summary.description || ''}\n${detailText}`),
  }
}

function parseIshPlusPage(html: string, pageUrl: string): Job[] {
  const matches = [...html.matchAll(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi)]
  const out: Job[] = []
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const title = stripHtml(match[1])
    if (title.length < 3 || title.length > 240) continue
    const start = Math.max(0, (match.index || 0) - 1_500)
    const end = matches[i + 1]?.index ?? Math.min(html.length, (match.index || 0) + 7_000)
    const block = html.slice(start, end)
    const text = htmlLines(block).join('\n')
    const postedAt = parseHiringActivityDate(text)
    if (!isRecent(postedAt)) continue
    const company = text.match(/(?:Организация|Tashkilot)\s*:\s*([^\n]{2,220})/iu)?.[1]?.trim() || 'IshPlus employer'
    const detailHref = [...block.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((item) => ({ href: item[1]!, text: stripHtml(item[2]) }))
      .find((item) => /подробнее|batafsil|details/iu.test(item.text) || /vacanc/i.test(item.href))?.href
    const location = text.split('\n').find((line) => Boolean(detectHiringLocationName(line, 'UZ'))) || 'Tashkent, Uzbekistan'
    const url = detailHref ? absoluteUrl(detailHref, pageUrl) : `${pageUrl}#${encodeURIComponent(title)}`
    out.push({
      ...makeJob({
        label: 'IshPlus.uz',
        title,
        company,
        location,
        url,
        postedAt: postedAt!,
        description: text,
        tags: ['Uzbekistan', 'Inclusive employment'],
        employerType: 'board',
      }),
      ...salary(text),
    })
  }
  return out
}

function parseMukPage(html: string): Job[] {
  const url = 'https://muk.group/ru/vacancies/'
  const out: Job[] = []
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/ru\/vacancies\/\d+\/?)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = stripHtml(match[2])
    const countryCode = detectCountryCodeFromText(raw)
    if (!countryCode) continue
    const title = raw.replace(/^\S+\s+/u, '').trim()
    if (title.length < 3) continue
    out.push(makeJob({
      label: 'MUK',
      title,
      company: 'MUK',
      location: geographyDisplayName(countryCode, 'en', 'country'),
      url: absoluteUrl(match[1]!, url),
      description: raw,
      tags: [countryCode],
      employerType: 'direct',
    }))
  }
  return out
}

export function parseMukVacancyDetail(html: string, url: string, summary?: Job): Job | null {
  const title = stripHtml(
    html.match(/<div\b[^>]*class=["'][^"']*\bnews-title\b[^"']*["'][^>]*>[\s\S]*?<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/iu)?.[1],
  )
  const rawLocation = stripHtml(
    html.match(/<div\b[^>]*class=["'][^"']*\bnews-info_left\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)?.[1],
  )
  const bodyStart = html.search(/<div\b[^>]*class=["'][^"']*\bnews-body\b[^"']*["'][^>]*>/iu)
  const footerStart = bodyStart >= 0
    ? html.slice(bodyStart).search(/<div\b[^>]*id=["']footer["'][^>]*>/iu)
    : -1
  const body = bodyStart >= 0
    ? html.slice(bodyStart, footerStart >= 0 ? bodyStart + footerStart : html.length)
    : ''
  const description = htmlLines(body).join('\n')

  if (!title || title.length > 240 || description.length < 40) return null
  if (!/(?:требования|обязанности|requirements|responsibilities|вимоги|обов'язки)/iu.test(description)) return null

  const countryCode = detectCountryCodeFromText(rawLocation || summary?.location || '')
  const location = countryCode
    ? geographyDisplayName(countryCode, 'en', 'country')
    : rawLocation || summary?.location || 'See listing'

  return makeJob({
    label: 'MUK',
    title,
    company: 'MUK',
    location,
    url,
    postedAt: summary?.postedAt,
    description,
    tags: countryCode ? [countryCode] : summary?.tags,
    employerType: 'direct',
  })
}

function parseTegenPage(html: string): Job[] {
  const url = 'https://tegen.uz/vacancy/'
  const headings = [...html.matchAll(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi)]
  const out: Job[] = []
  for (let i = 0; i < headings.length; i++) {
    const title = stripHtml(headings[i]![1])
    if (!title || /вакансии в tegen|карьера в tegen/iu.test(title) || title.length > 180) continue
    const start = headings[i]!.index || 0
    const end = headings[i + 1]?.index ?? html.length
    const description = htmlLines(html.slice(start, end)).join('\n')
    out.push(makeJob({
      label: 'Tegen',
      title,
      company: 'Tegen',
      location: 'Tashkent, Uzbekistan',
      url: `${url}#${encodeURIComponent(title.toLowerCase().replace(/\s+/g, '-'))}`,
      description,
      tags: ['Uzbekistan', 'Retail'],
      employerType: 'direct',
    }))
  }
  return out
}

function isUzbekistanAirwaysVacancyTitle(title: string): boolean {
  if (title.length < 5 || title.length > 300) return false
  return !/^(?:ESG(?:\s|$)|Путешествие по Узбекистану|Рекомендации по заполнению резюме|Резюме|Оказание услуг(?:\s|$))/iu.test(title)
}

export function parseUzbekistanAirwaysVacancyPage(html: string): Job[] {
  const root = 'https://corp.uzairways.com/ru/vacancy'
  const headingIndex = html.search(/Текущие(?:\s|&nbsp;)+вакансии/iu)
  if (headingIndex < 0) return []
  const afterHeading = html.slice(headingIndex)
  const endIndex = afterHeading.search(/class=["'][^"']*(?:pager|view-footer)[^"']*["']|Единый(?:\s|&nbsp;)+контакт-центр/iu)
  const vacancySection = afterHeading.slice(0, endIndex >= 0 ? endIndex : afterHeading.length)
  const byUrl = new Map<string, Job>()

  for (const match of vacancySection.matchAll(/<a\b[^>]*href=["']([^"']*\/ru\/node\/\d+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = stripHtml(match[2])
    if (!isUzbekistanAirwaysVacancyTitle(title)) continue
    const url = absoluteUrl(match[1]!, root)
    byUrl.set(url, makeJob({
      label: 'Uzbekistan Airways',
      title,
      company: 'Uzbekistan Airways',
      location: 'Uzbekistan',
      url,
      tags: ['Uzbekistan', 'Airline', 'Aviation'],
      employerType: 'direct',
    }))
  }
  return [...byUrl.values()]
}

export function parseUzbekistanAirwaysVacancyDetail(html: string, url: string): Job | null {
  const titleMatch = /<h1\b[^>]*class=["'][^"']*\bpage-heading\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/iu.exec(html)
  const title = stripHtml(titleMatch?.[1])
  if (!isUzbekistanAirwaysVacancyTitle(title)) return null

  const bodyMatches = [...html.matchAll(/<div\b[^>]*class=["'][^"']*\bcol-sm-12\b[^"']*\bcol-md-4\b[^"']*\bcol-xl-12\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/giu)]
  const description = bodyMatches
    .map((match) => htmlLines(match[1]).join('\n'))
    .filter((text) => /(?:обязанности|требования|условия|работодатель|резюме|ваканси|должностн)/iu.test(text))
    .sort((a, b) => b.length - a.length)[0] || ''
  if (description.length < 40) return null

  const location = description.split('\n').find((line) => Boolean(detectHiringLocationName(line, 'UZ')))
    || 'Uzbekistan'
  return makeJob({
    label: 'Uzbekistan Airways',
    title,
    company: 'Uzbekistan Airways',
    location,
    url,
    description,
    tags: ['Uzbekistan', 'Airline', 'Aviation'],
    employerType: 'direct',
  })
}

function parseCentrumAirPage(html: string): Job[] {
  const root = 'https://centrum-air.com/en/vacancies'
  const start = html.search(/Open positions/i)
  const end = html.search(/Career from the inside/i)
  const section = html.slice(Math.max(0, start), end > start ? end : html.length)
  const headings = [...section.matchAll(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi)]
  const out: Job[] = []

  for (let i = 0; i < headings.length; i++) {
    const title = stripHtml(headings[i]![1])
    if (!title || /open positions|benefits/iu.test(title)) continue
    const hStart = headings[i]!.index || 0
    const hEnd = headings[i + 1]?.index ?? section.length
    const block = section.slice(hStart, hEnd)
    const description = htmlLines(block).join('\n')
    const href = [...block.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => ({ href: match[1]!, text: stripHtml(match[2]) }))
      .find((item) => /read more|apply/iu.test(item.text))?.href
    out.push(makeJob({
      label: 'Centrum Air',
      title,
      company: 'Centrum Air',
      location: 'Tashkent, Uzbekistan',
      url: href ? absoluteUrl(href, root) : `${root}#${encodeURIComponent(title)}`,
      description,
      tags: ['Uzbekistan', 'Airline', 'Aviation'],
      employerType: 'direct',
    }))
  }
  return out
}

function conciseQanotTitle(value: string): string {
  if (/FEMALE flight attendant/iu.test(value)) return 'Flight Attendant'
  if (/position of captain.*co-pilot.*Airbus/iu.test(value)) return 'Captain / First Officer — Airbus A320/A321/A330'
  if (/Call Center Operator/iu.test(value)) return 'Call Center Operator'
  return value.replace(/^Position:\s*/iu, '').trim()
}

export function parseQanotSharqHtml(html: string): Job[] {
  const root = 'https://www.qanotsharq.com/en/vacancy'
  const headingPattern = /<span\b[^>]*class=["'][^"']*\btext-semibold\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/giu
  const headings = [...html.matchAll(headingPattern)]
  const jobs: Job[] = []

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    const rawTitle = stripHtml(heading[1])
    const segmentStart = heading.index ?? 0
    const segmentEnd = headings[index + 1]?.index ?? html.length
    const segment = html.slice(segmentStart, segmentEnd)
    const bodyStart = /<div\b[^>]*class=["'][^"']*\bbody-content\b[^"']*["'][^>]*>/iu.exec(segment)
    if (!rawTitle || !bodyStart || bodyStart.index == null) continue

    const contentStart = bodyStart.index + bodyStart[0].length
    const afterStart = segment.slice(contentStart)
    const submitButton = /<button\b[^>]*>[\s\S]*?Submit Resume/iu.exec(afterStart)
    const bodyHtml = afterStart.slice(0, submitButton?.index ?? afterStart.length)
    const description = htmlLines(bodyHtml).join('\n')
    if (!description) continue

    const title = conciseQanotTitle(rawTitle)
    jobs.push(makeJob({
      label: 'Qanot Sharq',
      title,
      company: 'Qanot Sharq Airlines',
      location: /location:\s*([^\n]+)/iu.exec(description)?.[1] || 'Tashkent, Uzbekistan',
      url: `${root}#${encodeURIComponent(title.toLowerCase().replace(/\s+/g, '-'))}`,
      description,
      tags: ['Uzbekistan', 'Airline', 'Aviation'],
      employerType: 'direct',
    }))
  }
  return jobs
}

interface MicrosoftResponse {
  operationResult?: {
    result?: {
      jobs?: Array<{
        jobId?: string | number
        title?: string
        description?: string
        properties?: {
          locations?: string[]
          employmentType?: string
          discipline?: string
          subDiscipline?: string
        }
      }>
    }
  }
}

function parseMicrosoftPage(raw: string): Job[] {
  let data: MicrosoftResponse
  try { data = JSON.parse(raw) as MicrosoftResponse } catch { return [] }
  const out: Job[] = []
  for (const item of data.operationResult?.result?.jobs || []) {
    if (!item.jobId || !item.title) continue
    const location = item.properties?.locations?.join('; ') || 'See listing'
    out.push(makeJob({
      label: 'Microsoft',
      title: item.title,
      company: 'Microsoft',
      location,
      url: `https://jobs.careers.microsoft.com/global/en/job/${item.jobId}`,
      description: item.description,
      employmentType: item.properties?.employmentType,
      tags: [item.properties?.discipline || '', item.properties?.subDiscipline || ''].filter(Boolean),
      employerType: 'direct',
    }))
  }
  return out
}

interface SmartRecruitersResponse {
  content?: Array<{
    id?: string
    name?: string
    releasedDate?: string
    company?: { name?: string }
    location?: { fullLocation?: string; city?: string; country?: string; remote?: boolean }
    typeOfEmployment?: { label?: string }
    function?: { label?: string }
    industry?: { label?: string }
  }>
}

function parseUbisoftPage(raw: string): Job[] {
  let data: SmartRecruitersResponse
  try { data = JSON.parse(raw) as SmartRecruitersResponse } catch { return [] }
  const out: Job[] = []
  for (const item of data.content || []) {
    if (!item.id || !item.name) continue
    const postedAt = item.releasedDate ? new Date(item.releasedDate).toISOString() : new Date().toISOString()
    if (!isRecent(postedAt)) continue
    const location = item.location?.fullLocation
      || [item.location?.city, item.location?.country].filter(Boolean).join(', ')
      || 'See listing'
    const job = makeJob({
      label: 'Ubisoft',
      title: item.name,
      company: item.company?.name || 'Ubisoft',
      location,
      url: `https://jobs.smartrecruiters.com/Ubisoft2/${item.id}`,
      postedAt,
      employmentType: item.typeOfEmployment?.label,
      tags: [item.function?.label || '', item.industry?.label || ''].filter(Boolean),
      employerType: 'direct',
    })
    if (item.location?.remote === true) job.remote = true
    out.push(job)
  }
  return out
}

function parseEaPage(html: string): Job[] {
  const root = 'https://jobs.ea.com/en_US/careers/SearchJobs/'
  const out: Job[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/careers\/JobDetail\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = stripHtml(match[2])
    if (title.length < 3 || title.length > 220) continue
    const url = absoluteUrl(match[1]!, root)
    if (seen.has(url)) continue
    seen.add(url)
    out.push(makeJob({
      label: 'Electronic Arts',
      title,
      company: 'Electronic Arts',
      location: 'See listing',
      url,
      tags: ['EA', 'Games'],
      employerType: 'direct',
    }))
  }
  return out
}

function parseEpamPage(html: string, country: string, pageUrl: string): Job[] {
  const jobs: Job[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/en\/vacancy\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = stripHtml(match[2])
    if (title.length < 3 || title.length > 220) continue
    const href = absoluteUrl(match[1]!, pageUrl)
    if (seen.has(href)) continue
    seen.add(href)
    jobs.push(makeJob({
      label: 'EPAM',
      title,
      company: 'EPAM',
      location: country,
      url: href,
      tags: ['IT'],
      employerType: 'direct',
    }))
  }
  return jobs
}

function parseJobsHorecaPage(html: string): Job[] {
  const root = 'https://jobshoreca.ro/'
  const out: Job[] = []
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = absoluteUrl(match[1]!, root)
    if (!/\/(?:job|jobs|locuri-de-munca)\/[a-z0-9][^/?#]{2,}/iu.test(new URL(href).pathname)) continue
    const title = stripHtml(match[2])
    if (title.length < 3 || title.length > 180) continue
    out.push(makeJob({
      label: 'Jobs HoReCa',
      title,
      company: 'Jobs HoReCa employer',
      location: 'Romania',
      url: href,
      tags: ['Romania', 'HoReCa'],
      employerType: 'board',
    }))
  }
  return out
}

export const SOURCE_EXPANSION_TARGET_PREFIX = 'source-expansion:'

const STATIC_SOURCE_TARGETS = [
  'ish-bor',
  'ishplus',
  'muk',
  'tegen',
  'uzbekistan-airways',
  'centrum-air',
  'qanot-sharq',
  'microsoft',
  'ubisoft',
  'ea',
  'epam-romania',
  'epam-kazakhstan',
  'epam-ukraine',
  'jobs-horeca-ro',
] as const

export function configuredSourceExpansionTargets(): string[] {
  if (process.env.SOURCE_EXPANSION_JOBS === 'off') return []
  return [
    ...ISHKOP_CITY_ROUTES.map(([key]) => `${SOURCE_EXPANSION_TARGET_PREFIX}ishkop-${key}`),
    ...STATIC_SOURCE_TARGETS.map((key) => `${SOURCE_EXPANSION_TARGET_PREFIX}${key}`),
  ]
}

export function isSourceExpansionTarget(target: string): boolean {
  return target.startsWith(SOURCE_EXPANSION_TARGET_PREFIX)
}

async function crawlSingleHtmlTarget(key: string, url: string, parsePage: (html: string) => Job[]): Promise<Job[]> {
  const run = await crawlStandardJobBoard({
    key: `source-expansion:${key}`,
    fetchPage: () => fetchHtml(url),
    parsePage: (html) => parsePage(html),
  })
  return run.jobs
}

async function fetchIshkopTarget(key: string): Promise<Job[]> {
  const route = ISHKOP_CITY_ROUTES.find(([routeKey]) => routeKey === key)
  if (!route) throw new Error(`Unknown Ishkop city target ${key}`)
  const [, label, city] = route
  const url = `https://ishkop.uz/${encodeURIComponent('вакансии')}/${encodeURIComponent(city)}`
  const run = await crawlStandardJobBoard({
    key: `source-expansion:ishkop-${key}`,
    fetchPage: () => fetchHtml(url),
    parsePage: (html) => parseIshkopPage(html, label),
  })
  return enrichStandardJobBoardDetails({
    key: `source-expansion:ishkop-${key}`,
    jobs: run.jobs,
    fetchDetail: (job) => fetchHtml(job.url),
    parseDetail: (html, summary) => parseIshkopVacancyDetail(html, summary.url) || summary,
  })
}

async function fetchIshBorTarget(): Promise<Job[]> {
  const listUrl = 'https://ish-bor.uz/ru/ishlar'
  const run = await crawlStandardJobBoard({
    key: 'source-expansion:ish-bor',
    fetchPage: () => fetchHtml(listUrl),
    parsePage: (html) => parseIshBorPage(html),
  })
  return enrichStandardJobBoardDetails({
    key: 'source-expansion:ish-bor',
    jobs: run.jobs,
    fetchDetail: (job) => fetchHtml(job.url),
    parseDetail: (html, summary) => parseIshBorDetail(html, summary),
  })
}

async function fetchIshPlusTarget(): Promise<Job[]> {
  const run = await crawlStandardJobBoard({
    key: 'source-expansion:ishplus',
    fetchPage: (page) => fetchHtml(`https://ishplus.uz/vacancies?lang=ru&page=${page}`),
    parsePage: (html, page) => parseIshPlusPage(html, `https://ishplus.uz/vacancies?lang=ru&page=${page}`),
  })
  return run.jobs
}

async function fetchMukTarget(): Promise<Job[]> {
  const run = await crawlStandardJobBoard({
    key: 'source-expansion:muk',
    fetchPage: () => fetchHtml('https://muk.group/ru/vacancies/'),
    parsePage: (html) => parseMukPage(html),
  })
  return enrichStandardJobBoardDetails({
    key: 'source-expansion:muk',
    jobs: run.jobs,
    fetchDetail: (job) => fetchHtml(job.url),
    parseDetail: (html, summary) => parseMukVacancyDetail(html, summary.url, summary) || summary,
  })
}

async function fetchUzbekistanAirwaysTarget(): Promise<Job[]> {
  const root = 'https://corp.uzairways.com/ru/vacancy'
  const run = await crawlStandardJobBoard({
    key: 'source-expansion:uzbekistan-airways',
    fetchPage: (page) => fetchHtml(page === 1 ? root : `${root}?page=${page - 1}`),
    parsePage: (html) => parseUzbekistanAirwaysVacancyPage(html),
  })
  return enrichStandardJobBoardDetails({
    key: 'source-expansion:uzbekistan-airways',
    jobs: run.jobs,
    fetchDetail: (job) => fetchHtml(job.url),
    parseDetail: (html, summary) => parseUzbekistanAirwaysVacancyDetail(html, summary.url) || summary,
  })
}

async function fetchMicrosoftTarget(): Promise<Job[]> {
  const endpoint = 'https://gcsservices.careers.microsoft.com/search/api/v1/search'
  const run = await crawlStandardJobBoard({
    key: 'source-expansion:microsoft',
    fetchPage: (page) => {
      // pgSz is the upstream API page shape; page traversal belongs to the shared crawler.
      const params = new URLSearchParams({ l: 'en_us', pg: String(page), pgSz: '100', o: String((page - 1) * 100), flt: 'true' })
      return fetchJsonText(`${endpoint}?${params}`)
    },
    parsePage: (raw) => parseMicrosoftPage(raw),
  })
  return run.jobs
}

async function fetchUbisoftTarget(): Promise<Job[]> {
  const run = await crawlStandardJobBoard({
    key: 'source-expansion:ubisoft',
    fetchPage: (page) => {
      // limit is the upstream SmartRecruiters page size, not a local item cap.
      const offset = (page - 1) * 100
      return fetchJsonText(`https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings?limit=100&offset=${offset}`)
    },
    parsePage: (raw) => parseUbisoftPage(raw),
  })
  return run.jobs
}

async function fetchEpamTarget(key: string): Promise<Job[]> {
  const configs: Record<string, [string, string]> = {
    'epam-romania': ['Romania', 'https://careers.epam.com/en/jobs/romania'],
    'epam-kazakhstan': ['Kazakhstan', 'https://careers.epam.com/en/jobs/kazakhstan'],
    'epam-ukraine': ['Ukraine', 'https://careers.epam.com/en/jobs/ukraine'],
  }
  const config = configs[key]
  if (!config) throw new Error(`Unknown EPAM target ${key}`)
  const [country, url] = config
  return crawlSingleHtmlTarget(key, url, (html) => parseEpamPage(html, country, url))
}

export async function fetchSourceExpansionTarget(target: string): Promise<Job[]> {
  if (!isSourceExpansionTarget(target)) throw new Error(`Unknown source expansion target ${target}`)
  const key = target.slice(SOURCE_EXPANSION_TARGET_PREFIX.length)
  if (key.startsWith('ishkop-')) return fetchIshkopTarget(key.slice('ishkop-'.length))
  if (key === 'ish-bor') return fetchIshBorTarget()
  if (key === 'ishplus') return fetchIshPlusTarget()
  if (key === 'muk') return fetchMukTarget()
  if (key === 'tegen') return crawlSingleHtmlTarget(key, 'https://tegen.uz/vacancy/', parseTegenPage)
  if (key === 'uzbekistan-airways') return fetchUzbekistanAirwaysTarget()
  if (key === 'centrum-air') return crawlSingleHtmlTarget(key, 'https://centrum-air.com/en/vacancies', parseCentrumAirPage)
  if (key === 'qanot-sharq') return crawlSingleHtmlTarget(key, 'https://www.qanotsharq.com/en/vacancy', parseQanotSharqHtml)
  if (key === 'microsoft') return fetchMicrosoftTarget()
  if (key === 'ubisoft') return fetchUbisoftTarget()
  if (key === 'ea') return crawlSingleHtmlTarget(key, 'https://jobs.ea.com/en_US/careers/SearchJobs/', parseEaPage)
  if (key.startsWith('epam-')) return fetchEpamTarget(key)
  if (key === 'jobs-horeca-ro') return crawlSingleHtmlTarget(key, 'https://jobshoreca.ro/', parseJobsHorecaPage)
  throw new Error(`Unknown source expansion target ${target}`)
}
