import { canonicalSkillName, extractSkillNames } from '~~/shared/jobSkills'
import {
  SENIORITY_RANK,
  bucketVacancyText,
  classifyCvSectionHeading,
  detectDegreeFields,
  detectDegreeLevel,
  detectHiringSeniority,
  extractCvExperienceYears,
  extractRequiredExperienceYears,
  isNoSponsorshipRequirement,
  requiresUsSponsorship as detectRequiresUsSponsorship,
  type DegreeLevel,
  type HiringSeniority as Seniority,
} from '@whiteslove/parsing-lexicon/hiring-requirements'
import { detectCountryCodeFromText } from '@whiteslove/parsing-lexicon/geography-detection'
import {
  detectDegreeRequirement,
  detectHiringScopeSignals,
  type HiringScopeCode,
} from '@whiteslove/parsing-lexicon/hiring-semantics'

// Client-side ATS (Applicant Tracking System) match scoring.
// The CV never leaves the browser. Unlike a keyword-only matcher, this scorer
// separates technical overlap from seniority, required experience, role scope,
// education and employment eligibility. Hard blockers can therefore keep an
// otherwise keyword-rich vacancy from being shown as a strong match.

/** Canonical skills present in a block of free text. */
function extractSkills(text: string): Set<string> {
  return new Set(extractSkillNames(text))
}

/** Map a pre-normalized skill string (e.g. from the server) to a canonical label. */
function canonical(skill: string): string | undefined {
  return canonicalSkillName(skill)
}

function canonicalSet(values: string[] | undefined): Set<string> {
  const result = new Set<string>()
  for (const value of values || []) {
    const normalized = canonical(value)
    if (normalized) result.add(normalized)
  }
  return result
}

const TERM_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'our', 'are', 'will', 'have', 'has',
  'who', 'what', 'when', 'where', 'which', 'their', 'they', 'them', 'about', 'within', 'across', 'using', 'including',
  'work', 'working', 'team', 'teams', 'role', 'company', 'years', 'year', 'experience', 'skills', 'skill', 'strong',
  'good', 'excellent', 'ability', 'knowledge', 'looking', 'required', 'requirements', 'preferred', 'responsibilities',
  'opportunity', 'candidate', 'position', 'professional', 'develop', 'development', 'build', 'building', 'software',
  'engineer', 'engineering', 'help', 'support', 'ensure', 'provide', 'plus', 'nice', 'must', 'need', 'needs',
  'для', 'что', 'как', 'или', 'это', 'мы', 'вы', 'ваш', 'ваша', 'ваши', 'наш', 'наша', 'наши', 'работа', 'работы',
  'работать', 'опыт', 'лет', 'года', 'год', 'команда', 'команды', 'знание', 'знания', 'навыки', 'требования',
  'обязанности', 'будет', 'нужно', 'необходимо', 'умение', 'разработка', 'разработки', 'позиция', 'кандидат',
  'або', 'це', 'ми', 'ви', 'робота', 'працювати', 'досвід', 'років', 'роки', 'знання', 'навички', 'вимоги',
  'обовязки', 'потрібно', 'необхідно', 'розробка', 'розробки',
])

function extractTerms(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[’']/g, '')
  const words = normalized.match(/[a-zа-яёіїєґ][a-zа-яёіїєґ0-9+#.-]{2,}/gi) || []
  return new Set(words.filter((word) => !TERM_STOP_WORDS.has(word) && !/^\d+$/.test(word)))
}

function coverage(have: Set<string>, wanted: Set<string>): number {
  if (!wanted.size) return 0
  let found = 0
  for (const value of wanted) if (have.has(value)) found += 1
  return found / wanted.size
}

type CvSection = 'experience' | 'projects' | 'profile' | 'skills' | 'education' | 'other'

const SECTION_EVIDENCE_WEIGHT: Record<CvSection, number> = {
  experience: 1,
  projects: 0.7,
  profile: 0.55,
  skills: 0.4,
  education: 0.35,
  other: 0.45,
}

function skillEvidenceFromCv(raw: string): Map<string, number> {
  const evidence = new Map<string, number>()
  const lines = raw.replace(/\r/g, '').split('\n')
  let section: CvSection = 'other'
  const add = (text: string, weight: number) => {
    for (const skill of extractSkills(text)) evidence.set(skill, Math.max(evidence.get(skill) || 0, weight))
  }
  for (const line of lines) {
    const trimmed = line.trim()
    const nextSection = classifyCvSectionHeading(trimmed)
    if (nextSection) {
      section = nextSection
      continue
    }
    if (trimmed) add(trimmed, SECTION_EVIDENCE_WEIGHT[section])
  }
  for (const skill of extractSkills(raw)) if (!evidence.has(skill)) evidence.set(skill, 0.45)
  return evidence
}

export interface CvProfile {
  skills: Set<string>
  skillEvidence: Map<string, number>
  terms: Set<string>
  raw: string
  experienceYears?: number
  seniority?: Seniority
  degreeLevel?: DegreeLevel
  degreeFields: Set<string>
  requiresUsSponsorship?: boolean
}

export function buildCvProfile(cvText: string, referenceDate: Date = new Date()): CvProfile {
  return {
    skills: extractSkills(cvText),
    skillEvidence: skillEvidenceFromCv(cvText),
    terms: extractTerms(cvText),
    raw: cvText,
    experienceYears: extractCvExperienceYears(cvText, referenceDate) ?? undefined,
    seniority: detectHiringSeniority(cvText) || undefined,
    degreeLevel: detectDegreeLevel(cvText) || undefined,
    degreeFields: new Set(detectDegreeFields(cvText)),
    requiresUsSponsorship: detectRequiresUsSponsorship(cvText) ?? undefined,
  }
}

function seniorityScore(candidate: Seniority | undefined, required: Seniority | undefined): { score: number, gap: number } {
  if (!required) return { score: 100, gap: 0 }
  if (!candidate) return { score: 45, gap: 1 }
  const gap = SENIORITY_RANK[required] - SENIORITY_RANK[candidate]
  if (gap <= 0) return { score: 100, gap }
  if (gap === 1) return { score: 65, gap }
  if (gap === 2) return { score: 30, gap }
  return { score: 10, gap }
}

function experienceScore(candidate: number | undefined, required: number | undefined): { score: number, gap: number } {
  if (required === undefined) return { score: 100, gap: 0 }
  if (candidate === undefined) return { score: 35, gap: required }
  if (candidate >= required) return { score: 100, gap: 0 }
  const ratio = required > 0 ? candidate / required : 1
  const score = ratio >= 0.85 ? 75 : ratio >= 0.7 ? 55 : ratio >= 0.5 ? 35 : 15
  return { score, gap: Math.max(0, Math.round((required - candidate) * 10) / 10) }
}

type ScopeCode = HiringScopeCode
const SCOPE_LABELS: Record<ScopeCode, string> = {
  architecture: 'Architecture / system design',
  leadership: 'Technical leadership',
  mentoring: 'Mentoring engineers',
  scale: 'Large-scale systems',
  ownership: 'Product / feature ownership',
}

function scopeScore(jobText: string, cvText: string): { score: number, missing: string[], requiredCount: number } {
  const required = detectHiringScopeSignals(jobText, { mode: 'vacancy' })
  if (!required.length) return { score: 100, missing: [], requiredCount: 0 }
  const matched = new Set(detectHiringScopeSignals(cvText, { mode: 'candidate' }))
  const missing = required.filter((code) => !matched.has(code)).map((code) => SCOPE_LABELS[code])
  return {
    score: Math.round(((required.length - missing.length) / required.length) * 100),
    missing,
    requiredCount: required.length,
  }
}

const DEGREE_RANK: Record<DegreeLevel, number> = { secondary: 0, bachelor: 1, master: 2, doctorate: 3 }

function jobDegreeRequirement(requiredText: string): { level?: DegreeLevel, field?: string, equivalentExperience: boolean } {
  return detectDegreeRequirement(requiredText)
}

function educationScore(profile: CvProfile, requirement: ReturnType<typeof jobDegreeRequirement>): { score: number, fieldMismatch: boolean, levelMismatch: boolean } {
  if (!requirement.level && !requirement.field) return { score: 100, fieldMismatch: false, levelMismatch: false }
  const candidateRank = profile.degreeLevel ? DEGREE_RANK[profile.degreeLevel] : -1
  const requiredRank = requirement.level ? DEGREE_RANK[requirement.level] : -1
  const levelMismatch = requiredRank >= 0 && candidateRank < requiredRank
  const fieldMismatch = !!requirement.field && !profile.degreeFields.has(requirement.field) && !(requirement.field === 'computer_science' && profile.degreeFields.has('engineering'))
  if (levelMismatch) return { score: requirement.equivalentExperience ? 45 : 10, fieldMismatch, levelMismatch }
  if (fieldMismatch) return { score: requirement.equivalentExperience ? 60 : 35, fieldMismatch, levelMismatch }
  return { score: 100, fieldMismatch, levelMismatch }
}

function isUsRole(job: { country?: string, location?: string, title?: string, description?: string }): boolean {
  if ((job.country || '').toUpperCase() === 'US') return true
  const text = `${job.location || ''} ${job.title || ''} ${(job.description || '').slice(0, 1200)}`
  return detectCountryCodeFromText(text) === 'US'
}

export interface AtsBlocker { code: 'visa_sponsorship'; label: string; critical: true }
export interface AtsBreakdown { skills: number; experience: number; seniority: number; scope: number; education: number; relevance: number }
export interface AtsResult { score: number; fitScore: number; eligible: boolean; blockers: AtsBlocker[]; breakdown: AtsBreakdown; matched: string[]; missing: string[] }

interface AtsJob {
  title: string
  description?: string
  tags?: string[]
  skills?: string[]
  niceToHave?: string[]
  experienceMinYears?: number
  seniority?: string | null
  education?: string
  country?: string
  location?: string
  foreignerFriendly?: boolean
  sponsorshipConfidence?: string
  sponsorshipEvidence?: string[]
}

export function scoreJob(profile: CvProfile, job: AtsJob): AtsResult {
  const titleText = job.title || ''
  const tagText = (job.tags || []).join(' ')
  const description = job.description || ''
  const buckets = bucketVacancyText(description)
  const titleSkills = extractSkills(titleText)
  const tagSkills = extractSkills(tagText)
  const requiredTextSkills = extractSkills(buckets.required)
  const optionalTextSkills = extractSkills(buckets.optional)
  const contextTextSkills = extractSkills(buckets.context)
  const noiseSkills = extractSkills(buckets.noise)
  const serverRequired = canonicalSet(job.skills)
  const serverOptional = canonicalSet(job.niceToHave)
  const required = new Set<string>([...titleSkills, ...requiredTextSkills])
  const optional = new Set<string>(optionalTextSkills)
  const context = new Set<string>()
  for (const skill of serverRequired) {
    if (noiseSkills.has(skill) && !required.has(skill)) continue
    if (requiredTextSkills.has(skill) || titleSkills.has(skill)) required.add(skill)
    else context.add(skill)
  }
  for (const skill of serverOptional) {
    if (noiseSkills.has(skill) && !optionalTextSkills.has(skill)) continue
    optional.add(skill)
  }
  for (const skill of [...tagSkills, ...contextTextSkills]) {
    if (noiseSkills.has(skill) || required.has(skill) || optional.has(skill)) continue
    context.add(skill)
  }
  for (const skill of required) { optional.delete(skill); context.delete(skill) }
  for (const skill of optional) context.delete(skill)
  let possible = 0
  let earned = 0
  const matchedRequired: string[] = []
  const matchedOptional: string[] = []
  const matchedContext: string[] = []
  const missingSkills: string[] = []
  const evidenceFor = (skill: string): number => profile.skillEvidence.get(skill) ?? (profile.skills.has(skill) ? 0.45 : 0)
  for (const skill of required) {
    possible += 4
    const evidence = evidenceFor(skill)
    if (evidence > 0) { earned += 4 * evidence; matchedRequired.push(skill) } else missingSkills.push(skill)
  }
  for (const skill of optional) {
    possible += 1
    const evidence = evidenceFor(skill)
    if (evidence > 0) { earned += evidence; matchedOptional.push(skill) }
  }
  for (const skill of context) {
    possible += 0.35
    const evidence = evidenceFor(skill)
    if (evidence > 0) { earned += 0.35 * evidence; matchedContext.push(skill) }
  }
  const skillsScore = possible > 0 ? Math.round((earned / possible) * 100) : 60
  const requiredExperience = job.experienceMinYears ?? extractRequiredExperienceYears(`${buckets.required} ${description}`) ?? undefined
  const exp = experienceScore(profile.experienceYears, requiredExperience)
  const requiredSeniority = detectHiringSeniority(titleText) || (job.seniority ? detectHiringSeniority(job.seniority) : null) || undefined
  const seniority = seniorityScore(profile.seniority, requiredSeniority)
  const scope = scopeScore(`${titleText} ${buckets.required} ${description}`, profile.raw)
  const educationRequirement = jobDegreeRequirement(`${buckets.required} ${job.education || ''}`)
  const education = educationScore(profile, educationRequirement)
  const keywordSource = buckets.required || buckets.optional ? `${buckets.required} ${buckets.optional}` : `${titleText} ${tagText} ${buckets.context.slice(0, 1800)}`
  const jobTerms = extractTerms(keywordSource)
  const relevanceScore = jobTerms.size ? Math.round(coverage(profile.terms, jobTerms) * 100) : 60
  const breakdown: AtsBreakdown = {
    skills: Math.max(0, Math.min(100, skillsScore)), experience: exp.score, seniority: seniority.score, scope: scope.score, education: education.score, relevance: relevanceScore,
  }
  let fitScore = Math.round(breakdown.skills * 0.30 + breakdown.experience * 0.20 + breakdown.seniority * 0.20 + breakdown.scope * 0.15 + breakdown.education * 0.10 + breakdown.relevance * 0.05)
  if (seniority.gap >= 3) fitScore = Math.min(fitScore, 45)
  else if (seniority.gap === 2) fitScore = Math.min(fitScore, 58)
  if (exp.gap >= 2) fitScore = Math.min(fitScore, 55)
  if (education.fieldMismatch && !educationRequirement.equivalentExperience) fitScore = Math.min(fitScore, 60)
  if (scope.requiredCount >= 3 && scope.score < 40) fitScore = Math.min(fitScore, 45)
  fitScore = Math.max(0, Math.min(100, fitScore))
  const blockers: AtsBlocker[] = []
  const sponsorshipText = `${description} ${tagText} ${(job.sponsorshipEvidence || []).join(' ')}`
  if (isUsRole(job) && profile.requiresUsSponsorship === true && isNoSponsorshipRequirement(sponsorshipText)) blockers.push({ code: 'visa_sponsorship', label: 'Visa sponsorship unavailable', critical: true })
  const missingCriteria: string[] = []
  if (requiredExperience !== undefined && exp.gap > 0) missingCriteria.push(`${requiredExperience}+ years experience`)
  if (requiredSeniority && seniority.gap > 0) missingCriteria.push(`${requiredSeniority.charAt(0).toUpperCase() + requiredSeniority.slice(1)} seniority`)
  missingCriteria.push(...scope.missing)
  if (education.fieldMismatch && educationRequirement.field === 'computer_science') missingCriteria.push('Computer Science / related degree')
  else if (education.levelMismatch && educationRequirement.level) missingCriteria.push(`${educationRequirement.level} degree`)
  const matched = [...matchedRequired, ...matchedOptional, ...matchedContext]
  const blockerLabels = blockers.map((blocker) => blocker.label)
  const missing = [...blockerLabels, ...missingCriteria, ...missingSkills].filter((value, index, values) => values.indexOf(value) === index)
  return { score: blockers.length ? Math.min(fitScore, 49) : fitScore, fitScore, eligible: blockers.length === 0, blockers, breakdown, matched: matched.slice(0, 12), missing: missing.slice(0, 12) }
}

export function scoreColor(score: number): string {
  if (score >= 75) return '#34d399'
  if (score >= 50) return '#fbbf24'
  return '#f87171'
}
