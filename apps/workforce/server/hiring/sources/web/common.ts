import { detectCandidateRelocationPreference, detectCandidateRemotePreference } from '@whiteslove/parsing-lexicon/hiring-semantics'
import type { CvProfile } from '../../../../shared/contracts/hiring'
import {
  absoluteUrl,
  cityFrom,
  contacts,
  employment,
  htmlText,
  parseAge,
  parseExperience,
  parseSalary,
} from '../../../../shared/hiring/webFields'
import { normalizeCandidate } from '../../../utils/hiringNormalize'

export interface WebCvAdapter {
  key: string
  label: string
  country: 'UZ' | 'UA' | 'KZ' | 'RO' | 'KG'
  maxTitleChars?: number
  root: string
  pageUrl: (page: number) => string
  linkRe: RegExp
  extractBlocks?: (html: string, source: WebCvAdapter, page: number) => CandidateBlock[]
  parse: (block: CandidateBlock, source: WebCvAdapter) => CvProfile | null
}

export interface CandidateBlock {
  href: string
  title: string
  text: string
  html: string
}

export function blockAnchors(html: string, source: WebCvAdapter): CandidateBlock[] {
  const matches: Array<{ index: number; end: number; href: string; title: string }> = []
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const href = absoluteUrl(match[1]!, source.root)
    source.linkRe.lastIndex = 0
    if (!source.linkRe.test(href)) continue
    const title = htmlText(match[2]!)
    if (!title || title.length > (source.maxTitleChars ?? 240)) continue
    matches.push({ index: match.index, end: re.lastIndex, href, title })
  }

  const byProfile: Array<{ href: string; first: number; end: number; titles: string[] }> = []
  for (const item of matches) {
    const current = byProfile[byProfile.length - 1]
    if (current && current.href === item.href) {
      current.end = Math.max(current.end, item.end)
      current.titles.push(item.title)
      continue
    }
    byProfile.push({ href: item.href, first: item.index, end: item.end, titles: [item.title] })
  }

  return byProfile.map((item, index) => {
    const start = Math.max(0, item.first - 350)
    const nextStart = byProfile[index + 1]?.first
    const end = nextStart ?? Math.min(html.length, item.end + 5_000)
    const sliced = html.slice(start, end)
    const cut = start > 0 ? sliced.indexOf('>') : -1
    const trimmed = cut >= 0 && cut < 400 ? sliced.slice(cut + 1) : sliced
    const orphan = trimmed.search(/<\/(?:script|style)>/i)
    const opens = trimmed.search(/<(?:script|style)\b/i)
    const raw = orphan >= 0 && (opens < 0 || orphan < opens)
      ? trimmed.slice(trimmed.indexOf('>', orphan) + 1)
      : trimmed
    const title = item.titles.reduce(
      (longest, candidate) => candidate.length > longest.length ? candidate : longest,
      '',
    )
    return { href: item.href, title, html: raw, text: htmlText(raw) }
  })
}

export function candidateBlocks(html: string, source: WebCvAdapter, page = 1): CandidateBlock[] {
  return source.extractBlocks?.(html, source, page) ?? blockAnchors(html, source)
}

export function buildWebProfile(
  source: WebCvAdapter,
  block: CandidateBlock,
  activity: string,
  partial: Partial<CvProfile>,
): CvProfile {
  const publicContacts = contacts(block.text, source.country)
  const hasDirect = Boolean(publicContacts.phone || publicContacts.email || publicContacts.telegram)
  const idToken = block.href
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(-180)
  const originalText = block.text.slice(0, 4_000)
  const age = partial.age ?? parseAge(block.text)

  return normalizeCandidate({
    id: `web-${source.key}-${idToken}`,
    source: 'telegram',
    origin: 'web',
    sourceKey: source.key,
    country: source.country,
    name: partial.name || '',
    role: partial.role || block.title,
    url: block.href,
    publishedAt: partial.publishedAt ?? null,
    updatedAt: partial.updatedAt ?? activity,
    activityAt: activity,
    createdAt: activity,
    originalText,
    description: originalText,
    tags: [source.label, 'Web CV', source.country],
    contacts: publicContacts,
    contact: publicContacts.telegram || publicContacts.email || publicContacts.phone || block.href,
    contactType: hasDirect ? 'direct' : 'platform',
    age,
    isAdult: age == null ? true : age >= 18,
    city: partial.city ?? cityFrom(block.text, source.country),
    experienceYears: partial.experienceYears ?? parseExperience(block.text),
    employmentTypes: partial.employmentTypes ?? employment(block.text),
    remote: partial.remote ?? detectCandidateRemotePreference(block.text),
    relocationReady: partial.relocationReady ?? detectCandidateRelocationPreference(block.text),
    ...parseSalary(block.text, source.country),
    ...partial,
  })
}

export function mergeSameCandidate(existing: CvProfile, incoming: CvProfile): CvProfile {
  const professions = [...new Set([
    ...(existing.professions || []),
    ...(incoming.professions || []),
    ...(existing.role ? [existing.role] : []),
    ...(incoming.role ? [incoming.role] : []),
  ].map((value) => value.trim()).filter(Boolean))]

  const newer = Date.parse(incoming.activityAt || '') > Date.parse(existing.activityAt || '') ? incoming : existing
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value != null && value !== '')),
    role: existing.role || incoming.role,
    professions,
    skills: [...new Set([...(existing.skills || []), ...(incoming.skills || [])])],
    activityAt: newer.activityAt,
    updatedAt: newer.updatedAt,
    originalText: existing.originalText,
  }
}
