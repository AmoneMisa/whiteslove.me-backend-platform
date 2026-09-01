import type { CvProfile } from '../../../../shared/contracts/hiring'
import { activityDate, cityFrom, isRecent, parseAge } from '../../../../shared/hiring/webFields'
import { buildWebProfile, type CandidateBlock, type WebCvAdapter } from './common'
import { crawlWebAdapter } from './crawler'

const AGE_LINE_RE = /^(\d{2})\s*(?:года|лет|год)\s*,?\s*(.*)$/iu
const SALARY_LINE_RE = /(\d[\d\s]{2,})\s*(?:KZT|₸|тенге)/iu

function parseRabotaKz(block: CandidateBlock, source: WebCvAdapter): CvProfile | null {
  const activity = activityDate(block.text)
  if (!isRecent(activity)) return null

  const lines = block.title.split('\n').map((line) => line.trim()).filter(Boolean)
  const ageIndex = lines.findIndex((line) => AGE_LINE_RE.test(line))
  if (ageIndex < 0 && lines.length < 3) return null

  const ageMatch = ageIndex >= 0 ? lines[ageIndex]!.match(AGE_LINE_RE) : null
  const age = ageMatch ? Number(ageMatch[1]) : parseAge(block.text)
  const name = ageIndex > 0 ? lines[ageIndex - 1]! : ''
  const city = ageMatch?.[2]?.trim() || cityFrom(block.text, 'KZ')

  const salaryIndex = lines.findIndex((line) => SALARY_LINE_RE.test(line))
  const roleIndex = ageIndex >= 0 ? ageIndex + 1 : 0
  const role = (salaryIndex === roleIndex ? '' : lines[roleIndex] || '').trim()
  const skills = salaryIndex >= 0
    ? lines.slice(salaryIndex + 1).filter((line) => line.length >= 3 && line.length <= 70).slice(0, 12)
    : []

  return buildWebProfile(source, block, activity!, {
    name,
    role: role || block.title.split('\n')[0] || '',
    city,
    age: Number.isFinite(age) ? age : null,
    skills,
    updatedAt: activity,
  })
}

export const RABOTA_KZ_SOURCE: WebCvAdapter = {
  key: 'rabotakz',
  label: 'Rabota.kz',
  country: 'KZ',
  root: 'https://rabota.kz/cv/list',
  maxTitleChars: 900,
  pageUrl: (page) => page === 1 ? 'https://rabota.kz/cv/list' : `https://rabota.kz/cv/list?page=${page}`,
  linkRe: /rabota\.kz\/cv\/list\/[a-z0-9-]{8,}/i,
  parse: parseRabotaKz,
}

export async function crawlRabotaKz(cursor?: Parameters<typeof crawlWebAdapter>[1]) {
  return crawlWebAdapter(RABOTA_KZ_SOURCE, cursor)
}
