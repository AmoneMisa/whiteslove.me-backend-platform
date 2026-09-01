import { canonicalTashkentDistrict, parseSalary as parseSharedSalary } from '@whiteslove/parsing-lexicon'
import {
  extractCandidateContacts,
  extractCandidateExperienceYears,
  parseCandidateExperienceValue,
} from '@whiteslove/parsing-lexicon/hiring-candidate-fields'
import {
  detectCandidateFeatureCodes,
  detectCandidateRelocationPreference,
  detectCandidateRemotePreference,
} from '@whiteslove/parsing-lexicon/hiring-semantics'
import type { CvProfile } from '../contracts/hiring'
import { extractCandidateAge, extractCandidateName } from './candidateFields'
import { ishBorProfileHtml } from './ishBorFields'
import { cityFrom, employment, htmlText } from './webFields'
import type { IshBorSummary } from './sources/ishBorCrawler'
import { ISHBOR_SOURCE_KEY } from './sources/ishBorSource'

const MAX_AGE_MONTHS = 3

type NormalizeCandidate = (profile: CvProfile) => CvProfile

function htmlLines(value: string): string[] {
  return htmlText(value).split('\n').filter(Boolean)
}

function cutoff(): number {
  const date = new Date()
  date.setUTCMonth(date.getUTCMonth() - MAX_AGE_MONTHS)
  return date.getTime()
}

function validRecent(value: string | null): value is string {
  if (!value) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && time >= cutoff() && time <= Date.now() + 48 * 60 * 60 * 1000
}

function dottedIso(day: string, month: string, year: string): string | null {
  const value = Date.UTC(Number(year), Number(month) - 1, Number(day), 12)
  return Number.isFinite(value) && value <= Date.now() + 48 * 60 * 60 * 1000
    ? new Date(value).toISOString()
    : null
}

function detailActivity(html: string, text: string): string | null {
  const candidates: number[] = []
  for (const match of html.matchAll(
    /(?:dateModified|datePublished|article:modified_time|article:published_time)[^>\n]{0,180}(20\d{2}-\d{2}-\d{2}(?:T[^"'<\s]+)?)/giu,
  )) {
    const time = Date.parse(match[1]!)
    if (Number.isFinite(time) && time <= Date.now() + 48 * 60 * 60 * 1000) candidates.push(time)
  }
  for (const match of html.matchAll(/<time\b[^>]*datetime=["']([^"']+)["']/giu)) {
    const time = Date.parse(match[1]!)
    if (Number.isFinite(time) && time <= Date.now() + 48 * 60 * 60 * 1000) candidates.push(time)
  }
  for (const match of html.matchAll(
    /lucide:calendar[\s\S]{0,80}?(\d{1,2})[./-](\d{1,2})[./-](20\d{2})/gi,
  )) {
    const iso = dottedIso(match[1]!, match[2]!, match[3]!)
    if (iso) candidates.push(Date.parse(iso))
  }
  for (const match of text.matchAll(
    /(?:опубликован[оа]?|размещен[оа]?|обновлен[оа]?|дата\s+(?:публикации|обновления)|joylashtirilgan|yangilangan)[^\d\n]{0,32}(\d{1,2})[./-](\d{1,2})[./-](20\d{2})/giu,
  )) {
    const iso = dottedIso(match[1]!, match[2]!, match[3]!)
    if (iso) candidates.push(Date.parse(iso))
  }
  return candidates.length ? new Date(Math.max(...candidates)).toISOString() : null
}

function field(text: string, names: string): string | null {
  const match = text.match(new RegExp(`(?:^|\\n)(?:${names})\\s*[:—-]\\s*([^\\n]{2,180})`, 'iu'))
  return match?.[1]?.trim() || null
}

function parseRole(text: string, fallback: string): string {
  return (field(text, "so(?:['’‘])ralgan ish (?:joyi|turi)|qidirayotgan kasb|lavozim|kasb") || fallback).slice(0, 180)
}

function sourceSalary(text: string): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  const parsed = parseSharedSalary(text)
  if (!parsed || (parsed.min == null && parsed.max == null)) return {}
  const first = parsed.min ?? parsed.max
  const second = parsed.max ?? parsed.min
  if (first == null || !Number.isFinite(first) || first <= 0) return {}
  const upper = second != null && Number.isFinite(second) ? second : first
  return {
    salaryMin: Math.min(first, upper),
    salaryMax: Math.max(first, upper),
    currency: parsed.currency || 'UZS',
  }
}

function iconField(html: string, icon: string): string | null {
  const match = html.match(new RegExp(
    `lucide:${icon}"[^>]*></iconify-icon>\\s*(?:</div>\\s*)?<span[^>]*>([^<]{1,200})</span>`,
    'i',
  ))
  return match ? htmlText(match[1]!).trim() || null : null
}

export function parseIshBorMetaSalary(html: string): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  const raw = html.match(/name="description"\s+content="[^"]*?💵:\s*([^."]{1,80})/i)?.[1]?.trim()
  return raw ? sourceSalary(`salary ${raw}`) : {}
}

function iconExperience(html: string): number | null {
  const value = iconField(html, 'clock')
  return value ? parseCandidateExperienceValue(value) : null
}

function iconName(html: string): string {
  const value = iconField(html, 'user') || ''
  const name = value.replace(/\s*\((?:женщина|мужчина|ayol|erkak|female|male)\)\s*$/iu, '').trim()
  return name.length >= 2 && name.length <= 80 && !/^\d/.test(name) ? name : ''
}

function candidateFeatures(text: string): string[] {
  const codes = detectCandidateFeatureCodes(text)
  const features: string[] = []
  if (codes.includes('student')) features.push('Student')
  if (codes.includes('noExperience') || extractCandidateExperienceYears(text) === 0) features.push('No experience')
  return features
}

export function parseIshBorProfile(
  summary: IshBorSummary,
  detailHtml: string,
  normalizeCandidate: NormalizeCandidate,
): CvProfile | null {
  const profileHtml = ishBorProfileHtml(detailHtml)
  const detailText = htmlLines(profileHtml).join('\n')
  const activity = detailActivity(detailHtml, detailText)
  if (!validRecent(activity)) return null

  const combined = `${summary.text}\n${detailText}`
  const publicContacts = { ...extractCandidateContacts(detailText) }
  const hasDirect = Boolean(publicContacts.phone || publicContacts.email || publicContacts.telegram)
  const age = extractCandidateAge(combined)
  const role = parseRole(detailText, summary.role)
  const sourceId = summary.url.match(/\/id\/(\d+)/)?.[1] || summary.url

  return normalizeCandidate({
    id: `web-${ISHBOR_SOURCE_KEY}-${sourceId}`,
    source: 'telegram',
    origin: 'web',
    sourceKey: ISHBOR_SOURCE_KEY,
    country: 'UZ',
    name: iconName(profileHtml) || extractCandidateName(detailText),
    role,
    professions: [role],
    previousProfessions: [],
    features: candidateFeatures(combined),
    age,
    isAdult: age == null ? true : age >= 18,
    experienceYears: iconExperience(profileHtml) ?? extractCandidateExperienceYears(combined),
    city: cityFrom(iconField(profileHtml, 'map-pin') || '', 'UZ') || cityFrom(combined, 'UZ'),
    district: canonicalTashkentDistrict(combined),
    remote: detectCandidateRemotePreference(combined),
    relocationReady: detectCandidateRelocationPreference(combined),
    employmentTypes: employment(combined),
    education: iconField(profileHtml, 'graduation-cap')
      || field(detailText, "ma(?:['’‘])lumoti|ta(?:['’‘])lim|образование")
      || null,
    url: summary.url,
    publishedAt: null,
    updatedAt: activity,
    activityAt: activity,
    createdAt: activity,
    originalText: detailText.slice(0, 4_000),
    description: detailText.slice(0, 4_000),
    tags: ['ish-bor.uz', 'Web CV', 'Uzbekistan'],
    contacts: publicContacts,
    contact: publicContacts.telegram || publicContacts.email || publicContacts.phone || summary.url,
    contactType: hasDirect ? 'direct' : 'platform',
    ...sourceSalary(combined),
    ...parseIshBorMetaSalary(detailHtml),
  })
}
