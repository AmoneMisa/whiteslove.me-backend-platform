// Candidate profile normalization + deduplication.
// Free-form posts are normalized without overwriting the original message.

import { extractCandidateContacts, isCandidateNameHidden } from '@whiteslove/parsing-lexicon/hiring-candidate-fields'
import {
  extractCandidateExperienceMentions,
  parseCandidateSalary,
  sameHiringProfessionFamily,
} from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import { professionDisplayLabel } from '@whiteslove/parsing-lexicon/hiring-source-aliases'
import { canonicalSkillName, extractSkillDetails } from '~~/shared/jobSkills'
import type { CandidateEmploymentType, CvProfile } from './hiringTypes'
import type { Seniority } from './jobTypes'
import { extractCandidateAge, extractCandidateGender, extractCandidateName } from './hiringCandidateFields'
import { ishBorLocationFromText, trimIshBorProfileText } from './hiringIshBorFields'
import { careeristRoleFromText, trimCareeristProfileText } from './hiringCareeristFields'
import { parseSalary as parseWebSalary } from './hiringWebFields'
import {
  candidateFieldRegex,
  detectCandidateFeatureCodes,
  detectCandidateRelocationPreference,
  detectCandidateRemotePreference,
  detectEmploymentTypes,
  detectProfessionMatches,
  detectSharedSeniority,
  detectWorkModes,
  extractCandidateContactHours,
  extractCandidateGoalRole,
  extractCandidateSkillField,
  extractCandidateTargetContext,
  extractCandidateWorkHistory,
  isCandidateNonRoleValue,
  isCandidateNonTargetContext,
  isFlexibleCandidateRole,
  resolveSharedProfessionContext,
} from './hiringLexicon'

// A CV field mistakenly filled with employment/schedule info instead of
// education (a common source-board quirk). Checks the lexicon's own
// employmentType/workMode/schedule field-label vocabulary plus actual
// work-mode/employment-type values, rather than a hand-rolled word list.
export function mentionsEmploymentOrSchedule(text: string): boolean {
  return candidateFieldRegex('employmentType').test(text)
    || candidateFieldRegex('workMode').test(text)
    || candidateFieldRegex('schedule').test(text)
    || detectWorkModes(text).length > 0
    || detectEmploymentTypes(text).length > 0
}

const JUNIOR_CONTRADICTION_YEARS = 4

export function detectSeniority(text: string, experienceYears?: number | null): Seniority | null {
  const shared = detectSharedSeniority(text) as Seniority | null
  if (shared) {
    // Explicit staff/principal/lead/head/director/vp/chief must never collapse to senior.
    if ((shared === 'intern' || shared === 'junior') && (experienceYears ?? 0) >= JUNIOR_CONTRADICTION_YEARS) {
      return (experienceYears ?? 0) >= 6 ? 'senior' : 'middle'
    }
    return shared
  }
  if (experienceYears == null) return null
  if (experienceYears >= 6) return 'senior'
  if (experienceYears >= 3) return 'middle'
  if (experienceYears >= 1) return 'junior'
  return null
}

function addSkill(out: Set<string>, raw: string) {
  const canonical = canonicalSkillName(raw)
  if (canonical) out.add(canonical)
  else {
    const trimmed = raw.trim().replace(/\s{2,}/g, ' ')
    if (trimmed.length >= 2 && trimmed.length <= 60) out.add(trimmed)
  }
}

export function normalizeSkills(rawSkills: string[] | undefined, text: string): string[] {
  const out = new Set<string>()
  for (const raw of rawSkills || []) addSkill(out, raw)

  // Structured UZ CV cards commonly call this field `Texnologiya`, singular.
  // Keep unknown but meaningful entries (e.g. DRF, Telegram Bot) instead of
  // relying only on the canonical skill catalogue.
  const structured = extractCandidateSkillField(text)
  if (structured) {
    for (const raw of structured.split(/[,;/|•·]+/)) {
      if (raw.trim()) addSkill(out, raw)
    }
  }

  for (const { name } of extractSkillDetails(text)) out.add(name)
  return [...out]
}

function collectProfessions(source: string): string[] {
  return [...new Set(
    detectProfessionMatches(source, 16)
      .map((match) => match.label || professionDisplayLabel(match.canonical))
      .filter(Boolean),
  )]
}

function cleanRole(raw: string | undefined): string {
  return (raw || '').trim().replace(/^[#\-–—•*\s]+/, '').replace(/[.;,]+$/, '').replace(/\s{2,}/g, ' ').slice(0, 180)
}

function comparableRoleText(raw: string | undefined): string {
  return cleanRole(raw).toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, '')
}

export function detectMentionedProfessions(source: string): string[] {
  return collectProfessions(source)
}

function normalizeProvidedProfessions(items: string[] | undefined): string[] {
  const out: string[] = []
  for (const item of items || []) {
    const clean = cleanRole(item)
    if (!clean) continue
    const matches = collectProfessions(clean)
    for (const value of (matches.length ? matches : [clean])) {
      if (!out.includes(value)) out.push(value)
    }
  }
  return out
}

function targetContext(text: string): string {
  return extractCandidateTargetContext(text)
}

function extractGoalRole(text: string): string {
  return cleanRole(extractCandidateGoalRole(text) || undefined)
}

export function normalizeProfessions(rawRole: string | undefined, text: string): string[] {
  const target = cleanRole(rawRole)
  if (isFlexibleCandidateRole(target)) return ['Any Role']
  if (isCandidateNonRoleValue(target)) return []

  const resolved = resolveSharedProfessionContext(text, { mode: 'candidate', title: target }) as {
    desiredProfession?: { canonical?: string } | null
    mentionedProfessions?: Array<{ canonical?: string }>
  }
  const desired = resolved.desiredProfession?.canonical
  if (desired) return [professionDisplayLabel(desired) || desired]

  if (target && !isCandidateNonTargetContext(target)) {
    const targetMatches = collectProfessions(target)
    if (targetMatches.length) return targetMatches
  }

  const contextualMatches = collectProfessions(targetContext(text))
  if (contextualMatches.length) return contextualMatches
  return target && !isCandidateNonTargetContext(target) ? [target] : []
}

export function normalizeRole(role: string | undefined, text: string): string {
  return normalizeProfessions(role, text)[0] || cleanRole(role)
}

function workHistoryBlock(text: string): string {
  return extractCandidateWorkHistory(text)
}

export function normalizePreviousProfessions(text: string): string[] {
  const history = workHistoryBlock(text)
  return history ? collectProfessions(history) : []
}

const CANDIDATE_FEATURE_LABELS: Record<string, string> = {
  student: 'Student',
  parentalLeave: 'Parental leave',
  noExperience: 'No experience',
  partTime: 'Part-time',
  nightShift: 'Night shift',
  openToRelocation: 'Open to relocation',
}

export function extractCandidateFeatures(text: string): string[] {
  return detectCandidateFeatureCodes(text).map((code) => CANDIDATE_FEATURE_LABELS[code] || code)
}

// "Murojaat qilish vaqti: 8:00 - 22:00" is on nearly every structured UZ card
// and answers a real question — when may I call this person. Deliberately not
// matched on a bare "ish vaqti", which is the working schedule the candidate
// wants, not the hours they answer the phone.
export function extractContactHours(text: string): string | null {
  return extractCandidateContactHours(text)
}

export function extractContacts(
  text: string,
  country = '',
): { telegram?: string; email?: string; phone?: string } {
  return { ...extractCandidateContacts(text, country) }
}

export function extractAge(text: string): number | null {
  return extractCandidateAge(text)
}

export function extractCandidateSalary(
  text: string,
  country: string,
): Pick<CvProfile, 'salaryMin' | 'salaryMax' | 'currency'> {
  const parsed = parseCandidateSalary(text, country)
  if (!parsed || (parsed.min == null && parsed.max == null)) return {}
  return {
    salaryMin: parsed.min,
    salaryMax: parsed.max,
    ...(parsed.currency ? { currency: parsed.currency } : {}),
  }
}

export function detectRelocationReady(text: string): boolean | null {
  return detectCandidateRelocationPreference(text)
}

export function normalizeRemotePreference(
  raw: boolean | null | undefined,
  text: string,
  origin: CvProfile['origin'],
): boolean | null {
  const shared = detectCandidateRemotePreference(text)
  if (shared != null) return shared
  if ((origin ?? 'telegram') === 'telegram' && raw === false) return null
  return raw ?? null
}

export function normalizeRelevantExperience(
  raw: number | null | undefined,
  targetProfessions: string[],
  text: string,
): number | null | undefined {
  if (raw == null) return raw
  const years = Number(raw)
  if (!Number.isFinite(years)) return null

  const mentions = extractCandidateExperienceMentions(text)
    .filter((item) => Math.abs(item.years - years) < 0.001)
  if (!mentions.length || !targetProfessions.length) return raw

  const hasRelevantEvidence = mentions.some(({ context }) => {
    const mentioned = collectProfessions(context)
    // A generic "3 years experience" remains valid. We reject only when the
    // source explicitly ties those years to a different profession.
    if (!mentioned.length) return true
    return mentioned.some((profession) =>
      targetProfessions.some((target) => sameHiringProfessionFamily(profession, target)),
    )
  })
  return hasRelevantEvidence ? raw : null
}

export function normalizeEmploymentTypes(text: string, raw?: string | null): CandidateEmploymentType[] {
  return detectEmploymentTypes(`${raw || ''}
${text}`)
}

/** Removes text ligatures emitted by icon fonts from older stored web cards. */
function stripUiArtifacts(value: string): string {
  return value
    .replace(/\b(?:local_shipping|location_on|work_outline|account_circle)\b/giu, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .trim()
}

const RABOTA_UI_LINE_RE = /^(?:в избранное|скачать|скрыть|пожаловаться|развернуть)$/iu
const RABOTA_HEADER_RE = /^(?:найдено\s+[\d\s]+\s+резюме\s+в\s+казахстане|[\d\s]+\s+резюме\s+людей,\s+ищущих\s+работу\s+в\s+казахстане\.)/iu

/** Removes search-page chrome duplicated inside Rabota.kz resume cards. */
export function trimRabotaKzProfileText(value: string): string {
  const seen = new Set<string>()
  return stripUiArtifacts(value)
    .split('\n')
    .filter((line) => {
      const key = line.toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim()
      if (!key || RABOTA_UI_LINE_RE.test(key) || RABOTA_HEADER_RE.test(key) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Removes author/time/translation controls and engagement counters from Threads captures. */
export function trimThreadsProfileText(value: string, candidateName = ''): string {
  const normalizedName = candidateName.toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim()
  const lines = stripUiArtifacts(value).split('\n')
  const translateAt = lines.findIndex((line) => /^translate$/iu.test(line.trim()))
  const content = (translateAt >= 0 ? lines.slice(0, translateAt) : lines)
    .filter((line, index) => {
      const key = line.toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim()
      if (!key || /^\d+[smhdw]$/iu.test(key) || /^translate$/iu.test(key)) return false
      if (index === 0 && ((normalizedName && key === normalizedName) || (/^@?[a-z0-9._]{4,40}$/iu.test(key) && /^\d+[smhdw]$/iu.test(lines[1]?.trim() || '')))) return false
      return true
    })
  while (content.length && /^\d{1,5}$/.test(content.at(-1)!.trim())) content.pop()
  return content.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function sourceProfileText(profile: CvProfile, value: string): string {
  const clean = stripUiArtifacts(value)
  if (profile.sourceKey === 'rabotakz') return trimRabotaKzProfileText(clean)
  if (profile.origin === 'threads' || profile.sourceKey?.startsWith('threads-')) return trimThreadsProfileText(clean, profile.name)
  if (profile.sourceKey === 'ishbor-uz') return trimIshBorProfileText(clean)
  if (profile.sourceKey === 'careerist-uz') return trimCareeristProfileText(clean)
  if (profile.sourceKey?.startsWith('flagma')) return trimFlagmaProfileText(clean)
  return clean
}

/** Removes ad-loader JavaScript leaked by incomplete Flagma card fragments. */
function trimFlagmaProfileText(value: string): string {
  return stripUiArtifacts(value)
    .replace(
      /(?:^|\n)\s*try\s*\{\s*(?:\r?\n)?\s*\(?\s*(?:adsbygoogle|window\.adsbygoogle)[\s\S]{0,500}?\}\s*catch\s*\([^)]*\)\s*\{[\s\S]{0,500}?\}(?=\s*\n|$)/giu,
      '\n',
    )
    .split('\n')
    .filter((line) => !/^\s*(?:сохранить|save|\(?\s*adsbygoogle\b|window\.adsbygoogle\b|console\.log\s*\(|try\s*\{|\}?\s*catch\s*\([^)]*\)\s*\{|\}\s*;?)\s*$/iu.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizedCandidateSkills(profile: CvProfile, text: string): string[] {
  const rabotaKz = profile.sourceKey === 'rabotakz'
  const skipTextExtraction = profile.sourceKey === 'careerist-uz' || profile.sourceKey === 'ishbor-uz' || rabotaKz
  const rawSkills = skipTextExtraction
    ? rabotaKz
      ? (profile.skills || []).filter((skill) => (
          skill.length <= 60
          && !/(?:19|20)\d{2}|по\s+настоящее\s+время|колледж|университет|институт|училище|сентябр|октябр|ноябр|декабр|январ|феврал|март|апрел|ма[йя]|июн|июл|август/iu.test(skill)
        ))
      : []
    : profile.sourceKey?.startsWith('flagma')
      ? (profile.skills || []).filter((skill) => canonicalSkillName(skill) != null)
      : profile.skills
  const normalized = normalizeSkills(rawSkills, skipTextExtraction ? '' : text)
  if (!profile.sourceKey?.startsWith('flagma')) return normalized

  const history = workHistoryBlock(text)
  return normalized.filter((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Marketplace names are legitimate skills only when stated as skills.
    // In `Administrator, Uzum market, Buxoro` the same token is the employer.
    const company = new RegExp(
      `(?:^|[,;])\\s*${escaped}\\s+(?:market|marketplace|group|company|llc|ooo)\\s*(?:[,.;]|$)`,
      'iu',
    )
    const explicitSkill = new RegExp(
      `(?:skills|навыки|навички|stack|texnologiya(?:lar)?)\\s*[:—-][^\\n]{0,300}(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
      'iu',
    )
    return !company.test(history) || explicitSkill.test(text)
  })
}

function normalizeCandidateEducation(profile: CvProfile, text: string): string | null | undefined {
  const raw = profile.education?.trim() || ''
  const withoutPreviewBoilerplate = raw.replace(/\s*[·|]\s*Location:\s*[\s\S]*$/iu, '').trim()
  if (withoutPreviewBoilerplate && !mentionsEmploymentOrSchedule(withoutPreviewBoilerplate)) return withoutPreviewBoilerplate
  if (profile.sourceKey?.startsWith('flagma')) {
    const demographics = text.match(
      /\|\s*([^\n|]{0,120}(?:образован\p{L}*|освіт\p{L}*|studii|ta(?:['’])?lim)[^\n|]{0,120})/iu,
    )?.[1]?.trim()
    if (demographics && !mentionsEmploymentOrSchedule(demographics)) return demographics
    const shortDemographics = text.match(/\|\s*([^\n|]{2,80})/u)?.[1]?.trim()
    if (shortDemographics && /(?:высш|средн|бакалавр|магистр|колледж|лицей|образован)/iu.test(shortDemographics)) {
      return shortDemographics
    }
  }
  return raw ? null : profile.education
}

function validStoredContact(value: string | null | undefined): string | null {
  const raw = value?.trim() || ''
  if (!raw) return null
  if (/^https?:\/\//iu.test(raw) || /^@[A-Za-z0-9_]{4,32}$/u.test(raw) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(raw)) return raw
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 9 && digits.length <= 15 ? raw : null
}

function normalizeMixedScriptName(value: string): string {
  if ((value.match(/\p{Script=Cyrillic}/gu) || []).length < 2) return value
  const confusables: Record<string, string> = {
    A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  }
  return value.replace(/[ABCEHKMOPTXY]/g, (letter) => confusables[letter] || letter)
}

function normalizeCandidateNameCase(value: string): string {
  if (!value || value !== value.toLocaleLowerCase('ru') || !/\p{L}/u.test(value)) return value
  return value.replace(/(^|[\s-])(\p{L})/gu, (_match, boundary: string, letter: string) => (
    `${boundary}${letter.toLocaleUpperCase('ru')}`
  ))
}

export function normalizeCandidate(profile: CvProfile): CvProfile {
  // Repair rows parsed before Material Icon ligatures were removed from the
  // source HTML. Underscored glyph names are presentation markup, not CV text.
  const rawSourceText = stripUiArtifacts(profile.originalText || profile.description || '')
  const originalText = sourceProfileText(profile, rawSourceText)
  const goalRole = extractGoalRole(originalText)
  const sourceRole = profile.sourceKey === 'careerist-uz' ? careeristRoleFromText(originalText) : null
  const rawEffectiveRoleCandidate = cleanRole(goalRole || sourceRole || profile.role)
  const roleDuplicatesName = Boolean(comparableRoleText(rawEffectiveRoleCandidate))
    && comparableRoleText(rawEffectiveRoleCandidate) === comparableRoleText(profile.name)
  const rawEffectiveRole = roleDuplicatesName ? '' : rawEffectiveRoleCandidate
  const flexibleRole = isFlexibleCandidateRole(rawEffectiveRole)
  const effectiveRole = flexibleRole ? 'Any Role' : isCandidateNonRoleValue(rawEffectiveRole) ? '' : rawEffectiveRole
  // Repair already-stored rows where a loose adapter saved the whole labelled
  // line ("familya: ...") as the name. New parses and old data then converge.
  const rawName = profile.name?.trim() || ''
  const roleAsName = profile.origin === 'web' && rawName.split(/\s+/u).length <= 3
    && collectProfessions(rawName).length > 0
  const nameCandidate = rawName && !isCandidateNameHidden(rawName) && !roleAsName
    ? extractCandidateName(rawName) || rawName
    : extractCandidateName(originalText)
  const name = normalizeCandidateNameCase(normalizeMixedScriptName(isCandidateNameHidden(nameCandidate) ? '' : nameCandidate))
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 100)
  const text = `${name}\n${effectiveRole || ''}\n${originalText}`
  const extractedContacts = extractContacts(text, profile.country || profile.sourceCountry || '')
  const contacts = {
    ...(extractedContacts.telegram ? { telegram: extractedContacts.telegram } : {}),
    ...(extractedContacts.email ? { email: extractedContacts.email } : {}),
    ...(extractedContacts.phone ? { phone: extractedContacts.phone } : {}),
    ...(profile.contacts || {}),
  }
  // AI-enriched/current structured professions must survive subsequent feed and
  // Elasticsearch normalization. Only derive from free text when none exist.
  const providedProfessions = profile.sourceKey === 'careerist-uz' || flexibleRole || !effectiveRole
    ? []
    : normalizeProvidedProfessions(profile.professions)
  const professions = providedProfessions.length
    ? providedProfessions
    : normalizeProfessions(effectiveRole, originalText)
  const storedAge = profile.age != null && profile.age >= 14 && profile.age <= 90 ? profile.age : null
  const age = storedAge ?? extractAge(originalText)
  const parsedEmploymentTypes = normalizeEmploymentTypes(originalText, profile.employmentType)
  const employmentTypes = profile.sourceKey?.startsWith('flagma')
    ? parsedEmploymentTypes
    : profile.employmentTypes?.length ? profile.employmentTypes : parsedEmploymentTypes
  const relevantExperience = normalizeRelevantExperience(profile.experienceYears, professions, originalText)
  // Month-based durations (20 years 4 months) are repeating IEEE fractions.
  // One decimal is enough for the source precision and keeps JSON/UI readable.
  const experienceYears = relevantExperience == null ? null : Number(relevantExperience.toFixed(1))
  const storedCity = profile.city == null ? profile.city : stripUiArtifacts(profile.city) || null
  const city = profile.sourceKey === 'ishbor-uz'
    ? ishBorLocationFromText(rawSourceText) || storedCity
    : storedCity
  const remote = normalizeRemotePreference(profile.remote, originalText, profile.origin)
  const extractedSalary = profile.sourceKey === 'careerist-uz'
    ? parseWebSalary(originalText, profile.country)
    : profile.salaryMin == null && profile.salaryMax == null
      ? extractCandidateSalary(originalText, profile.country)
      : {}
  const replaceStoredSalary = profile.sourceKey === 'careerist-uz' && extractedSalary.salaryMin != null
  const salaryMin = replaceStoredSalary ? extractedSalary.salaryMin : profile.salaryMin ?? extractedSalary.salaryMin
  const salaryMax = replaceStoredSalary ? extractedSalary.salaryMax : profile.salaryMax ?? extractedSalary.salaryMax
  const currency = replaceStoredSalary ? extractedSalary.currency : profile.currency ?? extractedSalary.currency
  const education = normalizeCandidateEducation(profile, originalText)
  const gender = profile.gender === 'male' || profile.gender === 'female'
    ? profile.gender
    : extractCandidateGender(originalText)

  return {
    ...profile,
    name,
    originalText,
    description: sourceProfileText(profile, profile.description || originalText),
    role: professions[0] || (effectiveRole ? normalizeRole(effectiveRole, originalText) : ''),
    professions,
    previousProfessions: profile.previousProfessions?.length
      ? normalizeProvidedProfessions(profile.previousProfessions)
      : normalizePreviousProfessions(originalText),
    features: [...new Set([...(profile.features || []), ...extractCandidateFeatures(originalText)])],
    age,
    gender,
    isAdult: age == null ? true : age >= 18,
    experienceYears,
    city,
    education,
    salaryMin,
    salaryMax,
    currency,
    remote,
    relocationReady: profile.relocationReady ?? detectRelocationReady(originalText),
    employmentTypes,
    skills: normalizedCandidateSkills(profile, originalText),
    seniority: profile.seniority ?? detectSeniority(text, experienceYears),
    contact: validStoredContact(profile.contact) || contacts.telegram || contacts.email || contacts.phone
      || (profile.contactType === 'platform' ? profile.url : null),
    contactHours: profile.contactHours ?? extractContactHours(originalText),
    contacts,
  }
}

export function candidateFingerprint(profile: CvProfile): string {
  const contact = profile.contacts?.telegram || profile.contacts?.email || profile.contacts?.phone
  if (contact) return `c:${contact.toLowerCase()}`
  const name = (profile.name || '').toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, '')
  if (profile.origin === 'web' && name.length >= 4 && !isCandidateNameHidden(profile.name || '')) {
    const source = (profile.sourceKey || profile.source || '').toLocaleLowerCase('ru')
    const city = (profile.city || '').toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, '')
    const professions = [...(profile.professions || [])].sort().join(',').toLocaleLowerCase('en')
    const salary = `${profile.salaryMin ?? ''}:${profile.salaryMax ?? ''}:${profile.currency || ''}`
    return `p:${source}:${name}:${city}:${profile.age ?? ''}:${professions}:${salary}`
  }
  const text = `${(profile.professions || []).join(' ')} ${profile.role || ''} ${profile.originalText || profile.description || ''}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-zа-яёіїґ0-9]+/g, '')
    .slice(0, 400)
  if (text.length >= 40) return `t:${text}`
  return `k:${profile.source}:${profile.id}`
}

export function dedupeCandidates(profiles: CvProfile[]): CvProfile[] {
  const best = new Map<string, CvProfile>()
  for (const profile of profiles) {
    const key = candidateFingerprint(profile)
    const current = best.get(key)
    if (!current) {
      best.set(key, profile)
      continue
    }
    const a = Date.parse(profile.createdAt || '') || 0
    const b = Date.parse(current.createdAt || '') || 0
    if (a > b) best.set(key, profile)
  }
  return [...best.values()]
}
