import type { CvProfile } from '../../../../shared/contracts/hiring'
import {
  activityDate,
  cityFrom,
  dayMonthDate,
  htmlText,
  isRecent,
} from '../../../../shared/hiring/webFields'
import {
  blockAnchors,
  buildWebProfile,
  type CandidateBlock,
  type WebCvAdapter,
} from './common'
import { crawlWebAdapter } from './crawler'

function stableToken(value: string): string {
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(36)
}

function parsedActivity(block: CandidateBlock): string | null {
  return activityDate(block.text) || dayMonthDate(block.text)
}

function parsePublicCandidate(block: CandidateBlock, source: WebCvAdapter): CvProfile | null {
  if (/не\s+ищет\s+работу|не\s+шука[єе]\s+роботу|not\s+looking\s+for\s+work/iu.test(block.text)) return null

  let activity = parsedActivity(block)
  // BestJobs' logged-out public candidate index exposes a source-authoritative
  // "Active" state, but not a precise public timestamp. Treat continued
  // presence in that active index as current; persistence still expires a card
  // when the source stops returning it. We never attempt to unlock contacts.
  if (!activity && source.key === 'bestjobs-ro' && /(?:^|\n)Active(?:\n|$)/i.test(block.text)) {
    activity = new Date().toISOString()
  }
  if (!isRecent(activity)) return null

  let name = ''
  if (source.key === 'bestjobs-ro') {
    const lines = block.text.split('\n').map((line) => line.trim()).filter(Boolean)
    const active = lines.findIndex((line) => /^Active$/i.test(line))
    if (active >= 0) name = lines[active + 1] || ''
  }

  return buildWebProfile(source, block, activity!, {
    name,
    role: block.title,
    city: cityFrom(block.text, source.country),
    updatedAt: activity,
  })
}

function newJobBlocks(html: string, source: WebCvAdapter, page: number): CandidateBlock[] {
  const lines = htmlText(html).split('\n').map((line) => line.trim()).filter(Boolean)
  const blocks: CandidateBlock[] = []
  const seen = new Set<string>()

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^Обновлено:$/iu.test(lines[index] || '')) continue
    const stamp = lines[index + 1] || ''
    let roleIndex = index + 2
    while (roleIndex < lines.length && /^Обновлено:$/iu.test(lines[roleIndex] || '')) roleIndex += 2
    const role = lines[roleIndex] || ''
    if (!role || /^(?:сегодня|вчера|более\s+недели|\d+\s+(?:дн|недел))/iu.test(role)) continue

    let end = roleIndex + 1
    while (end < lines.length && !/^Обновлено:$/iu.test(lines[end] || '') && end - index < 24) end += 1
    const text = lines.slice(index, end).join('\n')
    const activity = activityDate(`${stamp}\n${text}`)
    if (!isRecent(activity)) continue
    const token = stableToken(`${role}|${text}`)
    if (seen.has(token)) continue
    seen.add(token)
    blocks.push({
      href: `${source.root}#resume=${page}-${token}`,
      title: role,
      text,
      html: text,
    })
  }
  return blocks
}

function bestJobsBlocks(html: string, source: WebCvAdapter, page: number): CandidateBlock[] {
  const linked = blockAnchors(html, source)
  if (linked.length) return linked

  const lines = htmlText(html).split('\n').map((line) => line.trim()).filter(Boolean)
  const blocks: CandidateBlock[] = []
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^Active$/i.test(lines[index] || '')) continue
    const title = lines[index - 1] || lines[index + 2] || ''
    if (!title || title.length > 220) continue
    let end = index + 1
    while (end < lines.length && !/^Active$/i.test(lines[end] || '') && end - index < 18) end += 1
    const start = Math.max(0, index - 1)
    const text = lines.slice(start, end).join('\n')
    const token = stableToken(text)
    if (seen.has(token)) continue
    seen.add(token)
    blocks.push({
      href: `${source.root}#candidate=${page}-${token}`,
      title,
      text,
      html: text,
    })
  }
  return blocks
}

function resumeUzBlocks(html: string, source: WebCvAdapter, page: number): CandidateBlock[] {
  const linked = blockAnchors(html, source)
  if (linked.length) return linked

  // Some Resume.uz responses expose the current catalogue cards without
  // navigable detail links. Preserve only cards that have an explicit recent
  // activity/date signal; never manufacture hidden profile/contact URLs.
  const lines = htmlText(html).split('\n').map((line) => line.trim()).filter(Boolean)
  const blocks: CandidateBlock[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const activity = activityDate(lines[index] || '') || dayMonthDate(lines[index] || '')
    if (!isRecent(activity)) continue
    const title = lines[index - 1] || ''
    if (!title || title.length < 3 || title.length > 220) continue
    const text = lines.slice(Math.max(0, index - 4), Math.min(lines.length, index + 10)).join('\n')
    const token = stableToken(text)
    blocks.push({
      href: `${source.root}#resume=${page}-${token}`,
      title,
      text,
      html: text,
    })
  }
  return blocks
}

export const REGIONAL_PUBLIC_CV_SOURCES: WebCvAdapter[] = [
  {
    key: 'resume-uz',
    label: 'Resume.uz · resumes',
    country: 'UZ',
    root: 'https://www.resume.uz/ru/resumes',
    pageUrl: (page) => page === 1 ? 'https://www.resume.uz/ru/resumes' : `https://www.resume.uz/ru/resumes?page=${page}`,
    linkRe: /resume\.uz\/ru\/(?:resume|resumes)\/(?!search(?:[/?#]|$))[^?#]+/i,
    extractBlocks: resumeUzBlocks,
    parse: parsePublicCandidate,
  },
  {
    key: 'enbek-kz',
    label: 'Enbek.kz · resumes',
    country: 'KZ',
    root: 'https://www.enbek.kz/ru/search/resume',
    pageUrl: (page) => page === 1 ? 'https://www.enbek.kz/ru/search/resume' : `https://www.enbek.kz/ru/search/resume?page=${page}`,
    linkRe: /enbek\.kz\/ru\/resume\/[^?#]+~\d+/i,
    parse: parsePublicCandidate,
  },
  {
    key: 'hh-kz',
    label: 'hh.kz · resumes',
    country: 'KZ',
    root: 'https://hh.kz/search/resume?area=40&order_by=publication_time',
    pageUrl: (page) => `https://hh.kz/search/resume?area=40&order_by=publication_time&page=${Math.max(0, page - 1)}`,
    linkRe: /(?:[a-z0-9-]+\.)?hh\.kz\/resume\/[a-f0-9]{16,}/i,
    parse: parsePublicCandidate,
  },
  {
    key: 'newjob-kg',
    label: 'NewJob.kg · resumes',
    country: 'KG',
    root: 'https://newjob.kg/resumes',
    pageUrl: (page) => page === 1 ? 'https://newjob.kg/resumes' : `https://newjob.kg/resumes?page=${page - 1}`,
    linkRe: /newjob\.kg\/(?:resume|resumes)\/[a-z0-9_-]+/i,
    extractBlocks: newJobBlocks,
    parse: parsePublicCandidate,
  },
  {
    key: 'hh-kg',
    label: 'HeadHunter.kg · resumes',
    country: 'KG',
    root: 'https://headhunter.kg/search/resume?area=48&order_by=publication_time',
    pageUrl: (page) => `https://headhunter.kg/search/resume?area=48&order_by=publication_time&page=${Math.max(0, page - 1)}`,
    linkRe: /(?:[a-z0-9-]+\.)?headhunter\.kg\/resume\/[a-f0-9]{16,}/i,
    parse: parsePublicCandidate,
  },
  {
    key: 'robota-ua',
    label: 'robota.ua · candidates',
    country: 'UA',
    root: 'https://robota.ua/candidates',
    pageUrl: (page) => page === 1 ? 'https://robota.ua/candidates' : `https://robota.ua/candidates?page=${page}`,
    linkRe: /robota\.ua\/candidates\/\d+/i,
    parse: parsePublicCandidate,
  },
  {
    key: 'jobsua',
    label: 'Jobs.ua · resumes',
    country: 'UA',
    root: 'https://jobs.ua/resume',
    pageUrl: (page) => page === 1 ? 'https://jobs.ua/resume' : `https://jobs.ua/resume/page-${page}`,
    linkRe: /jobs\.ua\/cv-[^?#/]+-\d+/i,
    parse: parsePublicCandidate,
  },
  {
    key: 'bestjobs-ro',
    label: 'BestJobs · public candidates',
    country: 'RO',
    root: 'https://www.bestjobs.eu/en/cv/search',
    pageUrl: (page) => page === 1 ? 'https://www.bestjobs.eu/en/cv/search' : `https://www.bestjobs.eu/en/cv/search/${page - 1}`,
    linkRe: /bestjobs\.eu\/en\/cv\/(?!search(?:[/?#]|$))[^?#]+/i,
    extractBlocks: bestJobsBlocks,
    parse: parsePublicCandidate,
  },
]

export const REGIONAL_PUBLIC_CV_ADAPTERS: Record<string, WebCvAdapter> = Object.fromEntries(
  REGIONAL_PUBLIC_CV_SOURCES.map((source) => [source.key, source]),
)

export function isRegionalPublicCvSource(key: string): boolean {
  return Boolean(REGIONAL_PUBLIC_CV_ADAPTERS[key])
}

export async function crawlRegionalPublicCv(
  key: string,
  cursor?: Parameters<typeof crawlWebAdapter>[1],
) {
  const source = REGIONAL_PUBLIC_CV_ADAPTERS[key]
  if (!source) throw new Error(`unknown regional public CV source: ${key}`)
  return crawlWebAdapter(source, cursor)
}
