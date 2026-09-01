// Pure filtering + de-dup + sorting + pagination + statistics. Fetching/caching
// lives in the route handler (server/api/jobs.get.ts), mirroring the site's
// headerMenu pattern. Jobs are enriched (enrich.ts) before filtering so the new
// structured filters and stats can operate on derived fields.

import { enrichJob, resolveCountry } from './enrich'
import { normalizeJobSeniority } from '../../utils/jobSeniority'
import { canonicalSkillName } from '~~/shared/jobSkills'
import type {
  Job,
  JobQuery,
  JobResponse,
  JobSource,
  JobStats,
  SalaryStat,
  SortKey,
  WorkMode,
} from '../../utils/jobTypes'

const ENRICHMENT_CACHE_MAX = 20_000
const enrichmentCache = new Map<string, { fingerprint: string; job: Job }>()

function cachedEnrichment(raw: Job): Job {
  if (raw.workMode !== undefined && raw.skillDetails !== undefined) return normalizeJobSeniority(raw)
  const key = raw.url || raw.id
  const fingerprint = `${raw.postedAt}|${raw.title}|${raw.description?.length || 0}`
  const cached = enrichmentCache.get(key)
  if (cached?.fingerprint === fingerprint) return cached.job
  const job = normalizeJobSeniority(enrichJob(raw))
  enrichmentCache.set(key, { fingerprint, job })
  if (enrichmentCache.size > ENRICHMENT_CACHE_MAX) {
    const oldest = enrichmentCache.keys().next().value
    if (oldest) enrichmentCache.delete(oldest)
  }
  return job
}

// User preference: favor CIS but exclude Russia & Belarus by default. Each country
// has its own matcher so the two can be toggled back on independently via the
// includeRu / includeBy query flags. Remote/worldwide postings are unaffected.
const RUSSIA_LOCATION = new RegExp(
  [
    'russia', 'russian federation', '\\bru\\b',
    'росси', 'рф\\b', 'москв', 'moscow', 'петербург', 'saint petersburg', 'st\\.? petersburg',
  ].join('|'),
  'i',
)
const BELARUS_LOCATION = new RegExp(
  ['belarus', 'belarusian', 'белар', 'білор', 'беларусь', 'минск', 'мінськ', 'minsk'].join('|'),
  'i',
)

function isExcludedLocation(job: Job, includeRu: boolean, includeBy: boolean): boolean {
  if (job.remote) return false
  const loc = job.location || ''
  if (/worldwide|anywhere|remote|global/i.test(loc)) return false
  const hay = `${loc} ${job.title || ''}`
  if (job.country === 'RU' || RUSSIA_LOCATION.test(hay)) return !includeRu
  if (job.country === 'BY' || BELARUS_LOCATION.test(hay)) return !includeBy
  return false
}

function matches(job: Job, query: JobQuery, oldestAllowed: number): boolean {
  const posted = new Date(job.postedAt).getTime()
  if (Number.isNaN(posted) || posted < oldestAllowed) return false

  if (isExcludedLocation(job, query.includeRu === true, query.includeBy === true)) return false

  if (query.remote !== undefined && job.remote !== query.remote) return false
  if (query.location) {
    const want = query.location.toLowerCase()
    const wantCode = resolveCountry(query.location)
    const hitText = job.location.toLowerCase().includes(want)
    const hitCode = wantCode !== undefined && job.country === wantCode
    if (!hitText && !hitCode) return false
  }
  if (query.cities.length) {
    const hay = `${job.location} ${job.title}`.toLowerCase()
    const hit = query.cities.some((term) => {
      const needle = term.toLowerCase()
      if (needle && hay.includes(needle)) return true
      const code = resolveCountry(term)
      return code !== undefined && job.country === code
    })
    if (!hit) return false
  }
  if (query.salaryMin !== undefined) {
    const pay = job.salaryUsd ?? job.salaryMax ?? job.salaryMin
    if (pay === undefined || pay < query.salaryMin) return false
  }
  if (query.q) {
    const hay = [
      job.title,
      job.company,
      job.location,
      job.tags.join(' '),
      job.description || '',
      ...(job.skills || []),
      ...(job.niceToHave || []),
    ].join(' ').toLowerCase()
    if (!hay.includes(query.q.toLowerCase())) return false
  }

  if (query.countries.length && !query.countries.includes(job.country || '')) return false
  if (query.workMode && job.workMode !== query.workMode) return false
  if (query.relocation && job.relocation !== query.relocation) return false
  if (query.employmentKind && job.employmentKind !== query.employmentKind) return false
  if (query.hasSalary && job.salaryMin === undefined && job.salaryMax === undefined) return false
  if (
    query.maxExperienceYears !== undefined
    && job.experienceMinYears !== undefined
    && job.experienceMinYears > query.maxExperienceYears
  ) {
    return false
  }
  if (query.foreignerFriendly !== undefined && job.foreignerFriendly !== query.foreignerFriendly) {
    return false
  }
  if (query.hideRiskyIndustries !== false && job.riskCategory) return false
  if (query.noExperience && !job.noExperience) return false
  if (query.language) {
    const langs = job.languages || []
    const want = query.language.toLowerCase()
    const hit = langs.find((l) => l.language.toLowerCase() === want)
    if (!hit) return false
    if (query.languageLevel && (hit.level || '').toLowerCase() !== query.languageLevel.toLowerCase()) {
      return false
    }
  }
  if (query.excludeLanguages.length) {
    const have = new Set((job.languages || []).map((l) => l.language.toLowerCase()))
    for (const ex of query.excludeLanguages) if (have.has(ex.toLowerCase())) return false
  }
  if (query.skills.length) {
    const have = new Set(
      [...(job.skills || []), ...(job.niceToHave || [])]
        .map((skill) => canonicalSkillName(skill) || skill)
        .map((skill) => skill.toLocaleLowerCase('en')),
    )
    for (const requested of query.skills) {
      const canonical = canonicalSkillName(requested) || requested
      if (!have.has(canonical.toLocaleLowerCase('en'))) return false
    }
  }
  return true
}

const comparators: Record<SortKey, (a: Job, b: Job) => number> = {
  date: (a, b) => +new Date(b.postedAt) - +new Date(a.postedAt),
  oldest: (a, b) => +new Date(a.postedAt) - +new Date(b.postedAt),
  title: (a, b) => a.title.localeCompare(b.title),
  company: (a, b) => a.company.localeCompare(b.company),
  salary: (a, b) => (b.salaryUsd ?? 0) - (a.salaryUsd ?? 0),
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? (sorted[mid] ?? 0)
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
}

function medianDecimal(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const value = sorted.length % 2
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  return Math.round(value * 10) / 10
}

function salaryStat(values: number[]): SalaryStat {
  if (!values.length) return { count: 0, medianUsd: 0, avgUsd: 0, minUsd: 0, maxUsd: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((s, v) => s + v, 0)
  return {
    count: sorted.length,
    medianUsd: median(sorted),
    avgUsd: Math.round(sum / sorted.length),
    minUsd: sorted[0] ?? 0,
    maxUsd: sorted[sorted.length - 1] ?? 0,
  }
}

interface GroupAccumulator {
  count: number
  salaries: number[]
}

interface ProfessionAccumulator extends GroupAccumulator {
  experiences: number[]
  byCountry: Record<string, GroupAccumulator>
  byCity: Record<string, GroupAccumulator>
}

function salaryValue(job: Job): number | undefined {
  return job.salaryUsd !== undefined && Number.isFinite(job.salaryUsd) && job.salaryUsd > 0
    ? job.salaryUsd
    : undefined
}

function experienceValue(job: Job): number | undefined {
  if (job.noExperience) return 0
  if (job.experienceMinYears === undefined || !Number.isFinite(job.experienceMinYears)) return undefined
  return Math.max(0, job.experienceMinYears)
}

function addGroup(target: Record<string, GroupAccumulator>, key: string, pay?: number): GroupAccumulator {
  const group = target[key] ||= { count: 0, salaries: [] }
  group.count += 1
  if (pay !== undefined) group.salaries.push(pay)
  return group
}

function groupedStat(group: GroupAccumulator) {
  return {
    count: group.count,
    salaryCount: group.salaries.length,
    medianUsd: group.salaries.length ? salaryStat(group.salaries).medianUsd : 0,
  }
}

function normalizeProfessionTitle(title: string): string {
  const primary = (title || '')
    .split(/\s+(?:[-–—|])\s+|,\s+/u)[0]
    ?.trim() || title.trim()
  const withoutLevel = primary
    .replace(/^(?:(?:senior|sr\.?|junior|jr\.?|middle|mid(?:-level)?|staff|principal|lead|intern(?:ship)?)\s+)+/iu, '')
    .replace(/\s+(?:level\s*)?(?:i{1,4}|v|\d+)$/iu, '')
    .trim()
  return withoutLevel || primary || 'Other'
}

// Use the existing shared skill taxonomy as the primary profession-area signal.
// This avoids maintaining another Frontend/Backend/Data/etc. dictionary solely for
// statistics. Raw titles are only a fallback for vacancies with no classified skills.
export function jobProfessionArea(job: Job): string {
  const counts = new Map<string, number>()
  for (const detail of [...(job.skillDetails || []), ...(job.niceToHaveDetails || [])]) {
    const key = detail.subcategory?.trim()
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
  return top || normalizeProfessionTitle(job.title)
}

function computeStats(jobs: Job[]): JobStats {
  const allSalaries: number[] = []
  const sourceGroups: Record<string, GroupAccumulator> = {}
  const countryGroups: Record<string, GroupAccumulator> = {}
  const professionGroups: Record<string, ProfessionAccumulator> = {}
  const byWorkMode: Record<WorkMode, number> = { remote: 0, hybrid: 0, office: 0, unknown: 0 }
  const byRelocation: JobStats['byRelocation'] = { offered: 0, none: 0, unknown: 0 }
  const byEmploymentKind: JobStats['byEmploymentKind'] = {
    fulltime: 0,
    parttime: 0,
    contract: 0,
    internship: 0,
    temporary: 0,
    unknown: 0,
  }
  const experience: JobStats['experience'] = {
    knownCount: 0,
    medianYears: null,
    noExperience: 0,
    upToOne: 0,
    oneToThree: 0,
    threeToFive: 0,
    fivePlus: 0,
    unknown: 0,
  }
  const experienceValues: number[] = []
  const byLanguage: Record<string, number> = {}
  const skillCount: Record<string, number> = {}
  const salaryTrend: JobStats['salaryTrend'] = []
  let foreignerFriendly = 0

  for (const job of jobs) {
    const pay = salaryValue(job)
    const requiredExperience = experienceValue(job)
    const profession = jobProfessionArea(job)

    addGroup(sourceGroups, job.source, pay)
    addGroup(countryGroups, job.country || 'OTHER', pay)

    const professionGroup = professionGroups[profession] ||= {
      count: 0,
      salaries: [],
      experiences: [],
      byCountry: {},
      byCity: {},
    }
    professionGroup.count += 1
    if (pay !== undefined) professionGroup.salaries.push(pay)
    if (requiredExperience !== undefined) professionGroup.experiences.push(requiredExperience)
    addGroup(professionGroup.byCountry, job.country || 'OTHER', pay)
    if (job.city) addGroup(professionGroup.byCity, job.city, pay)

    if (pay !== undefined) {
      allSalaries.push(pay)
      salaryTrend.push({
        postedAt: job.postedAt,
        salaryUsd: pay,
        ...(job.country ? { country: job.country } : {}),
        ...(job.city ? { city: job.city } : {}),
        title: job.title,
        profession,
        ...(requiredExperience !== undefined ? { experienceYears: requiredExperience } : {}),
      })
    }

    byWorkMode[job.workMode || 'unknown'] += 1
    byRelocation[job.relocation || 'unknown'] += 1
    byEmploymentKind[job.employmentKind || 'unknown'] += 1
    if (job.foreignerFriendly) foreignerFriendly += 1

    if (requiredExperience === undefined) {
      experience.unknown += 1
    } else {
      experience.knownCount += 1
      experienceValues.push(requiredExperience)
      if (job.noExperience || requiredExperience === 0) experience.noExperience += 1
      else if (requiredExperience <= 1) experience.upToOne += 1
      else if (requiredExperience <= 3) experience.oneToThree += 1
      else if (requiredExperience <= 5) experience.threeToFive += 1
      else experience.fivePlus += 1
    }

    for (const l of job.languages || []) {
      byLanguage[l.language] = (byLanguage[l.language] || 0) + 1
    }
    for (const s of [...(job.skills || []), ...(job.niceToHave || [])]) {
      skillCount[s] = (skillCount[s] || 0) + 1
    }
  }

  experience.medianYears = medianDecimal(experienceValues)

  const bySource: JobStats['bySource'] = {}
  for (const [src, group] of Object.entries(sourceGroups)) {
    bySource[src as JobSource] = groupedStat(group)
  }

  const byCountry: JobStats['byCountry'] = {}
  for (const [country, group] of Object.entries(countryGroups)) {
    byCountry[country] = groupedStat(group)
  }

  const byProfession: JobStats['byProfession'] = Object.entries(professionGroups)
    .map(([profession, group]) => {
      const geographies = [
        ...Object.entries(group.byCountry).map(([key, value]) => ({ kind: 'country' as const, key, ...groupedStat(value) })),
        ...Object.entries(group.byCity).map(([key, value]) => ({ kind: 'city' as const, key, ...groupedStat(value) })),
      ]
        .filter((value) => value.salaryCount > 0)
        .sort((a, b) => b.count - a.count || b.salaryCount - a.salaryCount || b.medianUsd - a.medianUsd)
        .slice(0, 6)
      return {
        profession,
        ...groupedStat(group),
        medianExperienceYears: medianDecimal(group.experiences),
        geographies,
      }
    })
    .sort((a, b) => b.count - a.count || b.salaryCount - a.salaryCount)
    .slice(0, 20)

  const topSkills = Object.entries(skillCount)
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  return {
    salary: salaryStat(allSalaries),
    bySource,
    byCountry,
    byWorkMode,
    byRelocation,
    byEmploymentKind,
    experience,
    byProfession,
    foreignerFriendly,
    byLanguage,
    topSkills,
    salaryTrend,
  }
}

export function filterAndPaginate(all: Job[], query: JobQuery): JobResponse {
  const maxAge = Math.min(query.maxAgeDays || 14, 14)
  const oldestAllowed = Date.now() - maxAge * 86_400_000

  const perSource: JobResponse['sources'] = {}
  const seen = new Set<string>()
  const filtered: Job[] = []

  for (const raw of all) {
    if (!query.sources.includes(raw.source)) continue
    const job = cachedEnrichment(raw)
    if (!matches(job, query, oldestAllowed)) continue
    const key = job.url || job.id
    if (seen.has(key)) continue
    seen.add(key)
    perSource[job.source] = (perSource[job.source] || 0) + 1
    filtered.push(job)
  }

  const stats = computeStats(filtered)

  filtered.sort(comparators[query.sort] || comparators.date)

  const total = filtered.length
  const start = (query.page - 1) * query.pageSize
  const jobs = filtered.slice(start, start + query.pageSize)

  return { jobs, total, page: query.page, pageSize: query.pageSize, sources: perSource, stats }
}
