// Runtime-neutral helpers for public CV boards.
//
// Source HTML cleanup and retention policy stay here. Multilingual hiring
// semantics (dates, candidate fields, locations, salary and employment terms)
// are owned by @whiteslove/parsing-lexicon.

import {
  EMPLOYMENT_TYPES,
  findCanonical,
  parseSalary as parseSharedSalary,
} from '@whiteslove/parsing-lexicon'
import {
  extractCandidateAge,
  extractCandidateContacts,
  extractCandidateExperienceYears,
} from '@whiteslove/parsing-lexicon/hiring-candidate-fields'
import { detectHiringLocationName } from '@whiteslove/parsing-lexicon/hiring-location-fields'
import {
  AGO_SUFFIX,
  HIRING_MONTHS,
  UNICODE_LEFT_BOUNDARY,
  UNICODE_RIGHT_BOUNDARY,
  parseHiringActivityDate,
  parseHiringDayMonthDate,
} from '@whiteslove/parsing-lexicon/hiring-temporal'
import { decodeHtmlEntities } from '../htmlText'
import type { CvProfile } from './hiringTypes'

export const MAX_AGE_MONTHS = 3

// Compatibility exports for source adapters/tests. Values themselves live in
// parsing-lexicon and are no longer maintained in this repository.
export const MONTHS = HIRING_MONTHS
export const B = UNICODE_LEFT_BOUNDARY
export const E = UNICODE_RIGHT_BOUNDARY
export const AGO = AGO_SUFFIX
export {
  TODAY_RE,
  YESTERDAY_RE,
  HOURS_AGO_RE,
  DAYS_AGO_RE,
  WEEKS_AGO_RE,
  MONTHS_AGO_RE,
  YEARS_AGO_RE,
} from '@whiteslove/parsing-lexicon/hiring-temporal'
export { decodeHtmlEntities as decodeEntities } from '../htmlText'

export function htmlText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<([a-z][\w:-]*)\b[^>]*class=["'][^"']*(?:material-icons|material-symbols)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function absoluteUrl(raw: string, base: string): string {
  try {
    const url = new URL(decodeHtmlEntities(raw), base)
    url.hash = ''
    return url.toString()
  } catch {
    return raw
  }
}

export function cutoffDate(): Date {
  const value = new Date()
  value.setUTCMonth(value.getUTCMonth() - MAX_AGE_MONTHS)
  return value
}

export function isRecent(iso: string | null): boolean {
  if (!iso) return false
  const time = Date.parse(iso)
  return Number.isFinite(time) && time >= cutoffDate().getTime() && time <= Date.now() + 48 * 60 * 60 * 1000
}

export function activityDate(text: string): string | null {
  return parseHiringActivityDate(text)
}

export function dayMonthDate(text: string): string | null {
  return parseHiringDayMonthDate(text)
}

export function parseAge(text: string): number | null {
  return extractCandidateAge(text)
}

export function parseExperience(text: string): number | null {
  return extractCandidateExperienceYears(text)
}

export function parseSalary(text: string, _country: string): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  const parsed = parseSharedSalary(text)
  if (!parsed?.currency || (parsed.min == null && parsed.max == null)) return {}
  const first = parsed.min ?? parsed.max
  const second = parsed.max ?? parsed.min
  if (first == null || !Number.isFinite(first) || first <= 0) return {}
  const upper = second != null && Number.isFinite(second) ? second : first
  return {
    salaryMin: Math.min(first, upper),
    salaryMax: Math.max(first, upper),
    currency: parsed.currency,
  }
}

export function cityFrom(text: string, country: string): string | null {
  return detectHiringLocationName(text, country)
}

export function employment(text: string): CvProfile['employmentTypes'] {
  const out = new Set<'full_time' | 'part_time'>()
  for (const entry of EMPLOYMENT_TYPES) {
    if (!findCanonical(text, [entry], { partial: true })) continue
    if (entry.canonical === 'fullTime') out.add('full_time')
    if (entry.canonical === 'partTime') out.add('part_time')
  }
  return [...out]
}

export function contacts(text: string, country = ''): CvProfile['contacts'] {
  return { ...extractCandidateContacts(text, country) }
}
