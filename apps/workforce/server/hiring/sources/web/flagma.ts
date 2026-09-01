import { isCandidateNameHidden } from '@whiteslove/parsing-lexicon/hiring-candidate-fields'
import type { CvProfile } from '../../../../shared/contracts/hiring'
import {
  activityDate,
  cityFrom,
  isRecent,
  parseAge,
  parseExperience,
} from '../../../../shared/hiring/webFields'
import { buildWebProfile, type CandidateBlock, type WebCvAdapter } from './common'
import { crawlWebAdapter } from './crawler'

const FLAGMA_DEMOGRAPHICS_RE =
  /^\s*([^,|\n\d][^,|\n]{1,58})?\s*,?\s*(\d{2})\s*(?:года|лет|год|yil|ani|de ani)\s*,\s*([^,|\n]{2,60}?)\s*(?:,\s*([A-Z]{2})\b)?\s*(?:\||$)/mu
const FLAGMA_TARGET_RE = /(?:ищу|шукаю|qidiraman|caut)\s+(?:в|у|in)\s+([^\n]{3,120})/iu
const FLAGMA_EDUCATION_RE = /(?:Образование|Освіта|Ta['’]lim|Studii)\s*:?\s*([^\n]{3,240})/iu

function realName(value: string): string {
  if (!value || value.length > 100) return ''
  if (isCandidateNameHidden(value)) return ''
  return value
}

function parseFlagma(block: CandidateBlock, source: WebCvAdapter): CvProfile | null {
  const activity = activityDate(block.text)
  if (!isRecent(activity)) return null

  const lines = block.text.split('\n').map((line) => line.trim()).filter(Boolean)
  const demographicsIndex = lines.findIndex((line) => FLAGMA_DEMOGRAPHICS_RE.test(line))
  const demographics = demographicsIndex >= 0 ? lines[demographicsIndex]!.match(FLAGMA_DEMOGRAPHICS_RE) : null

  const inlineName = demographics?.[1]?.replace(/[,|]+$/, '').trim() || ''
  const rowAbove = demographicsIndex > 0 ? lines[demographicsIndex - 1]!.replace(/[,|]+$/, '').trim() : ''
  const nameCandidate = inlineName || rowAbove
  const name = !/^\d|€|\$|₸|сум|lei|сохранить|save/iu.test(nameCandidate)
    ? realName(nameCandidate)
    : ''

  const age = demographics ? Number(demographics[2]) : parseAge(block.text)
  const city = demographics?.[3]?.trim() || cityFrom(block.text, source.country)
  const candidateCountry = demographics?.[4]?.toUpperCase() || ''
  const targets = block.text.match(FLAGMA_TARGET_RE)?.[1]?.trim() || ''
  const demographicsTail = demographicsIndex >= 0
    ? (lines[demographicsIndex]!.split('|')[1] || '').trim()
    : ''
  const education = (/образован|освіт|ta['’]?lim|studii|образование/iu.test(demographicsTail) ? demographicsTail : '')
    || block.text.match(FLAGMA_EDUCATION_RE)?.[1]?.trim()
    || null
  const experienceYears = /без опыта работы|no experience|fără experiență/iu.test(block.text)
    ? 0
    : parseExperience(block.text)

  return buildWebProfile(source, block, activity!, {
    name,
    role: block.title,
    city,
    age: age != null && age >= 14 && age <= 90 ? age : null,
    education,
    experienceYears,
    relocationReady: targets ? true : undefined,
    ...(candidateCountry ? { country: candidateCountry, sourceCountry: source.country } : {}),
  })
}

export const FLAGMA_SOURCES: Record<'flagma-uz' | 'flagma-ro', WebCvAdapter> = {
  'flagma-uz': {
    key: 'flagma-uz',
    label: 'Flagma UZ',
    country: 'UZ',
    root: 'https://flagma.uz/ru/resume/',
    pageUrl: (page) => page === 1 ? 'https://flagma.uz/ru/resume/' : `https://flagma.uz/ru/resume/page-${page}/`,
    linkRe: /flagma\.uz\/(?:ru\/)?(?:rezyume|resume)-[^?#]*-rr\d+\.html/i,
    parse: parseFlagma,
  },
  'flagma-ro': {
    key: 'flagma-ro',
    label: 'Flagma RO',
    country: 'RO',
    root: 'https://flagma.ro/ru/resume/',
    pageUrl: (page) => page === 1 ? 'https://flagma.ro/ru/resume/' : `https://flagma.ro/ru/resume/page-${page}/`,
    linkRe: /flagma\.ro\/(?:ru\/)?(?:rezyume|resume)-[^?#]*-rr\d+\.html/i,
    parse: parseFlagma,
  },
}

export function isFlagmaSource(key: string): key is keyof typeof FLAGMA_SOURCES {
  return key === 'flagma-uz' || key === 'flagma-ro'
}

export async function crawlFlagma(key: keyof typeof FLAGMA_SOURCES, cursor?: Parameters<typeof crawlWebAdapter>[1]) {
  return crawlWebAdapter(FLAGMA_SOURCES[key], cursor)
}
