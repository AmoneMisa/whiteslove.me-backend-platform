// Deterministic repair layer for candidate cards.
//
// Source adapters intentionally stay conservative. This layer fixes structured
// facts that can be proven from the original CV text, including legacy records
// already persisted before a parser rule was added. It never guesses gender,
// remote status, location, or a profession from a person's name. Semantic AI
// enrichment remains authoritative for ambiguous free-form text.

import { isHiringNonCityLocation } from '@whiteslove/parsing-lexicon/hiring-location-fields'
import {
  extractCandidateDisplayName,
  extractCandidateExperienceMentions,
  isHiringCharityAppeal,
  isHiringRecruitingOpportunity,
  parseCandidateSalary,
} from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import type { CvProfile } from '~~/shared/contracts/hiring'
import { detectMentionedProfessions } from './hiringNormalize'
import {
  detectCandidateProfessionLabels,
  detectCandidateRemotePreference,
  detectLexiconCity,
  extractCandidateGoalField,
  extractCandidateLocationField,
  extractCandidateRoleField,
  extractCandidateSkillField,
  extractCandidateTargetContext,
  isCandidateStatusOnly,
  normalizeHiringCountry,
  resolveSharedCountryFromText,
} from './hiringLexicon'

function cleanToken(value: string): string {
  return value.replace(/^[#@\s]+|[#@\s]+$/g, '').replace(/\s+/g, ' ').trim()
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function candidateTargetContext(profile: CvProfile, text: string): string {
  const roleFieldRaw = extractCandidateRoleField(text)
  const roleField = roleFieldRaw && !isCandidateStatusOnly(cleanToken(roleFieldRaw)) ? roleFieldRaw : ''
  const goal = extractCandidateGoalField(text) || ''
  const target = extractCandidateTargetContext(text)
  const headline = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4).join('\n')
  return [profile.role || '', ...(profile.professions || []), roleField, goal, target, headline].join('\n')
}

function repairProfessions(profile: CvProfile, text: string): string[] {
  const current = unique(profile.professions?.length ? profile.professions : [profile.role || ''])
  const target = candidateTargetContext(profile, text)
  const semantic = [...detectCandidateProfessionLabels(target)]
  if (semantic.length) return unique(semantic)
  if (!current.length) {
    const technologies = extractCandidateSkillField(text) || ''
    const inferred = [...detectCandidateProfessionLabels('', `${technologies} ${(profile.skills || []).join(' ')}`)]
    if (inferred.length) return unique(inferred)
    const headline = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 8).join('\n')
    const headlineProfessions = detectMentionedProfessions(headline)
    if (headlineProfessions.length) return headlineProfessions
  }
  return current
}

function explicitLocation(text: string): string | null {
  return extractCandidateLocationField(text)
}

function countryFromLocation(value: string | null): { code: string; name: string } | null {
  if (!value) return null
  const code = resolveSharedCountryFromText(value)
  return code ? { code, name: cleanToken(value) } : null
}

function cityFromLocation(value: string | null, country: { code: string; name: string } | null): string | null {
  if (!value || !country) return null
  const cleaned = cleanToken(value)
  if (!cleaned) return null
  const known = detectLexiconCity(cleaned, country.code)
  if (known) return known
  const first = cleanToken(cleaned.split(',')[0] || '')
  if (!first || normalizeHiringCountry(first)) return null
  if (isHiringNonCityLocation(first)) return null
  return first.slice(0, 80)
}

function approximateExperience(text: string): number | null {
  const mentions = extractCandidateExperienceMentions(text)
  return mentions.find((item) => item.approximate)?.years ?? null
}

function candidateSalary(text: string, country: string): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> | null {
  const parsed = parseCandidateSalary(text, country)
  if (!parsed || (parsed.min == null && parsed.max == null)) return null
  return {
    salaryMin: parsed.min,
    salaryMax: parsed.max,
    currency: parsed.currency,
  }
}

/**
 * Training, bootcamp and recruitment-program announcements belong to Job Finder,
 * not the candidate board. Requiring multiple program signals avoids rejecting a
 * real candidate merely because their CV says they previously completed a course.
 */
/** True when the post asks for help rather than offering work. */
export function isCharityAppeal(text: string): boolean {
  return isHiringCharityAppeal(text)
}

export function isRecruitingOpportunity(text: string): boolean {
  return isHiringRecruitingOpportunity(text)
}
/** Repair only facts supported by the original source text. */
export function repairCandidateProfile(profile: CvProfile): CvProfile {
  const text = profile.originalText || profile.description || ''
  if (!text) return profile

  const professions = repairProfessions(profile, text)
  const location = explicitLocation(text)
  const detectedCountry = countryFromLocation(location)
  const detectedCity = cityFromLocation(location, detectedCountry)
  const remoteSignal = detectCandidateRemotePreference(text)
  const experience = profile.experienceYears ?? approximateExperience(text)
  const salary = profile.salaryMin == null && profile.salaryMax == null
    ? candidateSalary(text, detectedCountry?.code || profile.country || '')
    : null

  let city = profile.city ?? null
  if (detectedCountry) {
    const currentCity = cleanToken(city || '')
    if (!detectedCity && normalizeHiringCountry(currentCity)) city = null
    else if (detectedCity) city = detectedCity
  }

  return {
    ...profile,
    name: profile.name || extractCandidateDisplayName(text) || '',
    role: professions[0] || profile.role,
    professions,
    country: detectedCountry?.code || profile.country,
    city,
    remote: remoteSignal ?? (profile.remote === true ? true : null),
    experienceYears: experience,
    ...(salary || {}),
  }
}
