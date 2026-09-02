import {
  defaultHiringCurrency,
  detectCandidatePostSignals,
  extractCandidateStructuredBlock,
  extractCandidateStructuredField,
} from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import type { CvProfile } from '../../../shared/contracts/hiring'
import type { HiringTelegramChannelDescriptor } from '../../../shared/hiring/sources/telegramChannels'
import { extractCandidateName } from '../../../shared/hiring/candidateFields'
import { isLikelyTelegramVacancy } from '../../utils/sources/sources'
import {
  classifySharedHiringMessage,
  detectEmploymentTypes,
  detectHiringIntent,
  detectLexiconCity,
  detectLexiconDistrict,
  detectProfessionMatches,
  detectWorkModes,
  parseHiringExperience,
  parseHiringSalary,
  parseSharedLanguageContext,
  resolveSharedProfessionContext,
} from '../../utils/hiring/hiringLexicon'

export type TelegramCandidateChannel = HiringTelegramChannelDescriptor

export interface TelegramMessageOutcome {
  profile: CvProfile | null
  candidateMarker: boolean
  reason?: 'expired' | 'vacancy' | 'quality'
}

const MAX_CANDIDATE_AGE_MONTHS = 3
const FUTURE_DATE_TOLERANCE_MS = 48 * 60 * 60 * 1000

function candidateCutoff(): number {
  const cutoff = new Date()
  cutoff.setUTCMonth(cutoff.getUTCMonth() - MAX_CANDIDATE_AGE_MONTHS)
  return cutoff.getTime()
}

function recentCandidateDate(dateIso: string | null | undefined): string | null {
  if (!dateIso) return null
  const date = new Date(dateIso)
  if (!Number.isFinite(date.getTime())) return null
  const now = new Date()
  if (date.getTime() < candidateCutoff() || date.getTime() > now.getTime() + FUTURE_DATE_TOLERANCE_MS) return null
  return date.toISOString()
}

export function isLikelyCvPost(text: string, cvFeed = false): boolean {
  const value = text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').trim()
  const compact = value.replace(/\s+/g, ' ')
  if (compact.length < 30) return false
  const candidateSignals = detectCandidatePostSignals(value)
  if (candidateSignals.emptyRecommendation) return false

  const kind = classifySharedHiringMessage(value)
  if (['vacancy', 'vacancy_digest', 'recruitment_ad', 'course', 'job_service', 'closed_vacancy', 'spam'].includes(kind)) return false
  const explicitIntent = kind === 'candidate' || detectHiringIntent(value).intent === 'candidate'
  const candidateForm = candidateSignals.candidateForm
  if (!explicitIntent && !candidateForm && isLikelyTelegramVacancy(compact)) return false

  const hasCvMarker = candidateSignals.cvMarker
  const firstPerson = candidateSignals.firstPerson
  const hasPersonalProfile = candidateSignals.personalProfile
  const hasRole = detectProfessionMatches(value, 1).length > 0
  const hasContact = candidateSignals.contact
  const sections = candidateSignals.sectionCount
  const parsedExperience = parseHiringExperience(value)
  const hasExperience = parsedExperience?.minYears != null || parsedExperience?.maxYears != null

  if (explicitIntent && (firstPerson || candidateForm || hasRole || hasContact || sections >= 1)) return true
  if (hasCvMarker && (candidateForm || hasRole || sections >= 1 || hasContact)) return true
  if (cvFeed && (firstPerson || hasCvMarker || candidateForm) && (hasRole || sections >= 1 || hasExperience || hasContact)) return true
  if (firstPerson && hasRole && (candidateForm || hasPersonalProfile || sections >= 1 || hasExperience || hasContact)) return true
  return false
}

function parseExperience(text: string): number | undefined {
  const parsed = parseHiringExperience(text)
  const years = parsed?.minYears ?? parsed?.maxYears ?? null
  return years != null && years > 0 && years <= 55 ? years : undefined
}

function parseRole(text: string): string {
  const profession = resolveSharedProfessionContext(text, { mode: 'candidate' }) as {
    desiredProfession?: { matched?: string; canonical?: string } | null
    currentProfession?: { matched?: string; canonical?: string } | null
  }
  const target = profession.desiredProfession || profession.currentProfession
  return String(target?.matched || target?.canonical || '').trim().slice(0, 180)
}

function parseSkills(text: string): string[] {
  const skillsLine = extractCandidateStructuredField(text, 'skills', 500)
  if (!skillsLine) return []
  return [...new Set(skillsLine.split(/[,;/|•·]+/).map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 60))].slice(0, 20)
}

function parseLanguages(text: string): string[] {
  const parsed = parseSharedLanguageContext(text, 'candidate') as Array<{
    language: string
    name: string
    level: string | null
    cefr: string | null
  }>
  if (parsed.length) {
    return parsed.slice(0, 8).map((item) => {
      const level = item.cefr || item.level
      return level ? `${item.name} — ${level}` : item.name
    })
  }
  const raw = extractCandidateStructuredField(text, 'languages', 500)
    || extractCandidateStructuredBlock(text, 'languages', 500)
  return raw ? raw.split(/[,;/|•·]+/).map((item) => item.trim()).filter(Boolean).slice(0, 8) : []
}

export function detectCity(text: string, country: string): string | null {
  return detectLexiconCity(text, country)
}

function fallbackChannelCity(channel: TelegramCandidateChannel): string | null {
  return detectLexiconCity(channel.location || '', channel.country)
}

export function detectDistrict(text: string, city: string | null): string | null {
  const explicit = extractCandidateStructuredField(text, 'district', 220)
  return detectLexiconDistrict(explicit || text, city) || explicit || null
}

function parseSalary(text: string, country: string): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  const parsed = parseHiringSalary(text)
  if (!parsed || (parsed.min == null && parsed.max == null)) return {}
  const currency = parsed.currency || defaultHiringCurrency(country) || undefined
  return {
    salaryMin: parsed.min ?? parsed.max ?? undefined,
    salaryMax: parsed.max ?? parsed.min ?? undefined,
    currency,
  }
}

export function telegramMessageToProfile(
  text: string,
  opts: { id: string; url: string; dateIso: string | null | undefined },
  channel: TelegramCandidateChannel,
  needle: string,
): CvProfile | null {
  const createdAt = recentCandidateDate(opts.dateIso)
  if (!createdAt) return null
  const lowerText = text.toLocaleLowerCase('ru')
  const localToChannel = !channel.includeAny?.length
    || channel.includeAny.some((marker) => lowerText.includes(marker.toLocaleLowerCase('ru')))
  if (channel.requireCandidateMarker && detectHiringIntent(text).intent !== 'candidate') return null
  if (!isLikelyCvPost(text, channel.cvFeed)) return null

  const name = extractCandidateName(text)
  const role = parseRole(text)
  const skills = parseSkills(text)
  if (needle && !`${name} ${role} ${text} ${skills.join(' ')}`.toLocaleLowerCase('ru').includes(needle)) return null

  const explicitLocation = extractCandidateStructuredField(text, 'city', 220)
    || extractCandidateStructuredField(text, 'address', 220)
  const explicitCity = explicitLocation ? detectCity(explicitLocation, channel.country) || explicitLocation : null
  const city = localToChannel
    ? explicitCity || detectCity(text, channel.country) || fallbackChannelCity(channel)
    : explicitCity || null
  const district = detectDistrict(text, city)
  const contact = extractCandidateStructuredField(text, 'contact', 220) || undefined
  const employmentType = detectEmploymentTypes(text)[0]
    || extractCandidateStructuredField(text, 'employmentType', 120)
    || extractCandidateStructuredField(text, 'schedule', 120)
    || undefined
  const education = extractCandidateStructuredField(text, 'education', 500)
    || extractCandidateStructuredBlock(text, 'education', 800)
    || null
  const hashtags = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,40})/gu)].map((match) => match[1]!)
  const salary = parseSalary(text, channel.country)

  return {
    id: opts.id,
    source: 'telegram',
    sourceCountry: channel.country,
    country: localToChannel ? channel.country : '',
    name,
    role,
    experienceYears: parseExperience(text),
    ...salary,
    city,
    district,
    remote: detectWorkModes(`${role} ${text}`).includes('remote'),
    url: opts.url,
    createdAt,
    originalText: text,
    description: text,
    skills,
    languages: parseLanguages(text),
    education,
    tags: [...channel.tags, channel.country, `@${channel.handle}`, ...hashtags].slice(0, 10),
    contact,
    employmentType,
  }
}

function looksLikeVacancy(text: string): boolean {
  const kind = classifySharedHiringMessage(text)
  if (kind === 'vacancy' || kind === 'closed_vacancy') return true
  return isLikelyTelegramVacancy(text.replace(/\s+/g, ' '))
}

export function classifyTelegramMessage(
  text: string,
  opts: { id: string; url: string; dateIso: string | null | undefined },
  channel: TelegramCandidateChannel,
  needle: string,
): TelegramMessageOutcome {
  const candidateMarker = detectHiringIntent(text).intent === 'candidate'
  if (!recentCandidateDate(opts.dateIso)) return { profile: null, candidateMarker, reason: 'expired' }

  const profile = telegramMessageToProfile(text, opts, channel, needle)
  if (profile) return { profile, candidateMarker }
  return { profile: null, candidateMarker, reason: looksLikeVacancy(text) ? 'vacancy' : 'quality' }
}
