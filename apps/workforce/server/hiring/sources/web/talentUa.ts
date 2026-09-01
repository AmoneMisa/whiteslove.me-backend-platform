import { detectCandidateRelocationPreference } from '@whiteslove/parsing-lexicon/hiring-semantics'
import type { CvProfile } from '../../../../shared/contracts/hiring'
import { activityDate, cityFrom, dayMonthDate, htmlText, isRecent } from '../../../../shared/hiring/webFields'
import { buildWebProfile, type CandidateBlock, type WebCvAdapter } from './common'
import { crawlWebAdapter } from './crawler'

function ownCard(block: CandidateBlock): CandidateBlock {
  const anchor = Math.max(0, block.html.indexOf(block.href))
  const open = block.html.lastIndexOf('<div class="card">', anchor)
  const from = open >= 0 ? open : 0
  const close = block.html.indexOf('<div class="card">', from + 1)
  const html = close > from ? block.html.slice(from, close) : block.html.slice(from)
  return { ...block, html, text: htmlText(html) }
}

function parseTalent(sourceBlock: CandidateBlock, source: WebCvAdapter): CvProfile | null {
  const block = ownCard(sourceBlock)
  const stamp = htmlText(block.html.match(/class="date"[^>]*>\s*<div>([\s\S]*?)<\/div>/i)?.[1] || '')
  const activity = (stamp && (activityDate(stamp) || dayMonthDate(stamp))) || activityDate(block.text)
  if (!isRecent(activity)) return null

  const info = block.html.match(/class="card__info[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || ''
  const fields = [...info.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => htmlText(match[1]!))
    .filter(Boolean)
  const cityText = fields[fields.length - 1] || ''
  const name = fields.length > 1 ? fields[0]! : ''

  const skills = [...block.html.matchAll(/<a[^>]*href="[^"]*resumes\/search\?tag=\d+"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => htmlText(match[1]!))
    .filter(Boolean)
    .slice(0, 20)

  return buildWebProfile(source, block, activity!, {
    name,
    role: block.title,
    city: cityFrom(cityText, 'UA') || cityText || null,
    ...(skills.length ? { skills } : {}),
    updatedAt: activity,
    relocationReady: detectCandidateRelocationPreference(block.text),
  })
}

export const TALENT_SOURCE: WebCvAdapter = {
  key: 'talent-ua',
  label: 'Talent.UA',
  country: 'UA',
  root: 'https://talent.ua/ru/resumes/search',
  pageUrl: (page) => page === 1
    ? 'https://talent.ua/ru/resumes/search'
    : `https://talent.ua/ru/resumes/search/page${page}`,
  linkRe: /(?:talent\.ua|rabota\.[a-z0-9.-]+\.ua)\/ru\/resumes\/\d+/i,
  parse: parseTalent,
}

export async function crawlTalentUa(cursor?: Parameters<typeof crawlWebAdapter>[1]) {
  return crawlWebAdapter(TALENT_SOURCE, cursor)
}
