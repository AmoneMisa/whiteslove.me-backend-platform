import type { CvProfile } from '../../../../shared/contracts/hiring'
import { activityDate, cityFrom, isRecent, parseAge } from '../../../../shared/hiring/webFields'
import { trimCareeristProfileText } from '../../../utils/hiringCareeristFields'
import { buildWebProfile, type CandidateBlock, type WebCvAdapter } from './common'
import { crawlWebAdapter } from './crawler'

function labelledValue(lines: string[], label: RegExp): string | null {
  const index = lines.findIndex((line) => label.test(line))
  if (index < 0) return null
  const value = lines[index + 1]?.trim()
  return value && value.length <= 80 ? value : null
}

function parseCareerist(block: CandidateBlock, source: WebCvAdapter): CvProfile | null {
  const cleanBlock = { ...block, text: trimCareeristProfileText(block.text) }
  const activity = activityDate(cleanBlock.text)
  if (!isRecent(activity)) return null
  const after = cleanBlock.text.split(block.title).slice(1).join(block.title)
  const lines = after.split('\n').map((line) => line.trim()).filter(Boolean)

  const labelledCity = labelledValue(lines, /^город$/iu)
  const city = labelledCity && !/^\d/.test(labelledCity)
    ? labelledCity
    : cityFrom(after, 'UZ')

  const cityLabelIndex = lines.findIndex((line) => /^город$/iu.test(line))
  const nameCandidate = cityLabelIndex > 0 ? lines[cityLabelIndex - 1]! : ''
  const name = nameCandidate
    && nameCandidate.length <= 100
    && !/^(?:возраст|опыт работы|последнее место работы|отправить приглашение|подробнее|руб|\d)/iu.test(nameCandidate)
    ? nameCandidate
    : ''

  const labelledAge = labelledValue(lines, /^возраст$/iu)
  const age = labelledAge ? parseAge(labelledAge) : null
  const exp = after.match(/Опыт работы:\s*\n?\s*(\d+)\s*(?:год|года|лет)(?:\s+и\s+(\d+)\s+месяц)?/iu)
  const experienceYears = exp
    ? Number(exp[1]) + Number(exp[2] || 0) / 12
    : /Без опыта/iu.test(after) ? 0 : null

  return buildWebProfile(source, cleanBlock, activity!, {
    name,
    role: block.title,
    city,
    age,
    experienceYears,
    updatedAt: activity,
  })
}

export const CAREERIST_SOURCE: WebCvAdapter = {
  key: 'careerist-uz',
  label: 'Careerist UZ',
  country: 'UZ',
  root: 'https://uzbekistan.careerist.ru/resume/',
  pageUrl: (page) => page === 1
    ? 'https://uzbekistan.careerist.ru/resume/'
    : `https://uzbekistan.careerist.ru/resume/?page=${page - 1}`,
  linkRe: /(?:uzbekistan|tashkent|nukus|andijan|termez|gulistan|samarkand|bukhara|fergana|namangan)\.careerist\.ru\/resume\/[^?#]+\.html/i,
  parse: parseCareerist,
}

export async function crawlCareerist(cursor?: Parameters<typeof crawlWebAdapter>[1]) {
  return crawlWebAdapter(CAREERIST_SOURCE, cursor)
}
