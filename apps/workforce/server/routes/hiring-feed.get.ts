// GET /hiring-feed — read-only candidate CV/resume feed.
// Normal reads, filters, pagination and analytics use the Personal Site hiring
// PostgreSQL schema. Snapshot/Elasticsearch paths remain safe rollout fallbacks;
// crawling, normalization writes and backfill belong exclusively to jobs-worker.

import { getHiringSourceDiagnostics } from '../utils/hiringSources'
import { HIRING_COUNTRIES } from '../../shared/hiring/hiringMarkets'
import { DERIVED_VERSION, getStoredCvProfilesSnapshot } from '../utils/hiringSnapshot'
import { getStoredWebCvProfiles } from '../utils/hiringWebStore'
import { candidateSearchAvailable, searchCandidates } from '../utils/hiringElastic'
import { dedupeCandidates, detectMentionedProfessions, normalizeCandidate } from '../utils/hiringNormalize'
import { withProfessionExperience } from '../utils/hiringExperience'
import { listWebSources } from '../utils/hiringWebSources'
import { listUzJobsSources } from '../utils/hiringUzJobsSource'
import { getHiringWebDiagnostics } from '../utils/hiringDiagnostics'
import { loadDbSourceRuns } from '../utils/hiringDb'
import { convertCurrency, getRates, loadRates } from '../utils/currency'
import { buildHiringStatistics } from '../../shared/hiringStatistics'
import type { CvProfile } from '~~/shared/contracts/hiring'
import { canonicalCityKey, cityAliases, normalizeCityValue } from '../../shared/locationCatalog'
import {
  publicCandidateGender,
  publicCandidateLanguages,
  publicCandidateName,
  publicCandidateProfessionKeys,
  publicCandidateRemote,
  publicCandidateSalary,
} from '../utils/hiringCandidatePresentation'
import {
  HIRING_PROFESSION_LABELS,
  hiringProfessionLabel,
  hiringProfessionLocale,
  type HiringProfessionLocale,
} from '../../shared/hiringProfessionLabels'
import { hiringEducationLabel } from '../../shared/hiringEducationLabels'
import { publicEntityId } from '../../shared/publicEntityId'
import {
  collapseHiringProfessionFilterValues,
  expandHiringProfessionFilters,
} from '../../shared/hiringProfessionGroups'
import { hiringDbEnabled, queryDbCandidates } from '../hiring/infrastructure/database'

const PAGE_MAX = 60

function cityMatches(profile: CvProfile, requested: string): boolean {
  const canonical = canonicalCityKey(requested)
  if (profile.city && canonicalCityKey(profile.city) === canonical) return true
  const hay = `${profile.city || ''} ${profile.district || ''} ${profile.description || ''}`.toLocaleLowerCase('ru')
  return cityAliases(requested).some((alias) => hay.includes(normalizeCityValue(alias)))
}

function list(params: URLSearchParams, key: string): string[] {
  return (params.get(key) || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function profileSource(profile: CvProfile): string {
  return (profile.sourceKey || profile.source || 'unknown').toLowerCase()
}

function profileOrigin(profile: CvProfile): string {
  return (profile.origin || 'telegram').toLowerCase()
}

const WEB_SOURCE_LABELS = new Map(listWebSources().map((source) => [source.key, source.label]))

function profileProvider(profile: CvProfile): string {
  if (profile.sourceLabel?.trim()) return profile.sourceLabel.trim()
  const key = profile.sourceKey?.toLowerCase()
  if (key && WEB_SOURCE_LABELS.has(key)) return WEB_SOURCE_LABELS.get(key)!
  const origin = profileOrigin(profile)
  if (origin === 'facebook') return 'Facebook'
  if (origin === 'threads') return 'Threads'
  if (origin === 'web') return key || 'Web'
  return 'Telegram'
}

function canonicalProfessions(profile: CvProfile): string[] {
  return [...new Set([
    ...(profile.professions || []),
    profile.role,
  ].map((value) => String(value || '').trim()).filter(Boolean))]
}

function profileSearchText(profile: CvProfile): string {
  const professionTerms = [
    ...canonicalProfessions(profile),
    ...(profile.previousProfessions || []),
  ].flatMap((profession) => [
    profession,
    hiringProfessionLabel(profession, 'ru'),
    hiringProfessionLabel(profession, 'en'),
  ])

  return [
    profile.name,
    ...professionTerms,
    ...(profile.professionExperience || []).flatMap((item) => [
      `${item.profession} ${item.years}`,
      `${hiringProfessionLabel(item.profession, 'ru')} ${item.years}`,
      `${hiringProfessionLabel(item.profession, 'en')} ${item.years}`,
    ]),
    ...(profile.features || []),
    ...(profile.skills || []),
    profile.city || '',
    profile.district || '',
    profile.description || '',
  ].join(' ').toLocaleLowerCase('ru')
}

function salaryBounds(profile: CvProfile, targetCurrency: string): { low: number; high: number } | null {
  const sourceCurrency = profile.currency?.trim().toUpperCase()
  if (!sourceCurrency) return null
  const rawLow = profile.salaryMin ?? profile.salaryMax
  const rawHigh = profile.salaryMax ?? profile.salaryMin
  const low = convertCurrency(rawLow, sourceCurrency, targetCurrency)
  const high = convertCurrency(rawHigh, sourceCurrency, targetCurrency)
  if (low == null && high == null) return null
  const first = low ?? high!
  const second = high ?? low!
  return { low: Math.min(first, second), high: Math.max(first, second) }
}

function matchesFilters(profile: CvProfile, params: URLSearchParams): boolean {
  const countries = list(params, 'countries').map((code) => code.toUpperCase())
  if (countries.length && !countries.includes((profile.country || '').toUpperCase())) return false

  const city = (params.get('city') || '').trim()
  if (city && !cityMatches(profile, city)) return false

  const remote = params.get('remote')
  if (remote === '1' && !profile.remote) return false
  if (remote === '0' && profile.remote) return false

  const expMin = Number(params.get('experienceMin'))
  if (Number.isFinite(expMin) && expMin > 0) {
    if (profile.experienceYears == null || profile.experienceYears < expMin) return false
  }

  const ageMin = Number(params.get('ageMin'))
  if (Number.isFinite(ageMin) && ageMin > 0) {
    if (profile.age == null || profile.age < ageMin) return false
  }

  const ageMax = Number(params.get('ageMax'))
  if (Number.isFinite(ageMax) && ageMax > 0) {
    if (profile.age == null || profile.age > ageMax) return false
  }

  const salaryFrom = Number(params.get('salaryFrom'))
  const salaryTo = Number(params.get('salaryTo'))
  if ((Number.isFinite(salaryFrom) && salaryFrom > 0) || (Number.isFinite(salaryTo) && salaryTo > 0)) {
    const targetCurrency = (params.get('salaryCurrency') || 'USD').trim().toUpperCase()
    const salary = salaryBounds(profile, targetCurrency)
    if (!salary) return false
    // Range-overlap semantics: a candidate is kept when their desired range has
    // at least one value inside the selected range. This makes "до 1000" include
    // e.g. a candidate asking for 800–1200, because 800 is still acceptable.
    if (Number.isFinite(salaryFrom) && salaryFrom > 0 && salary.high < salaryFrom) return false
    if (Number.isFinite(salaryTo) && salaryTo > 0 && salary.low > salaryTo) return false
  }

  const gender = (params.get('gender') || '').trim().toLowerCase()
  if (gender && (profile.gender || 'unknown') !== gender) return false

  const professions = list(params, 'professions')
  if (professions.length) {
    const owned = new Set(canonicalProfessions(profile))
    if (!expandHiringProfessionFilters(professions).some((profession) => owned.has(profession))) return false
  }

  const seniority = (params.get('seniority') || '').trim().toLowerCase()
  if (seniority && (profile.seniority || '') !== seniority) return false

  const skills = list(params, 'skills').map((skill) => skill.toLowerCase())
  if (skills.length) {
    const owned = new Set((profile.skills || []).map((skill) => skill.toLowerCase()))
    if (!skills.every((skill) => owned.has(skill))) return false
  }

  const languages = list(params, 'languages').map((language) => language.toLowerCase())
  if (languages.length) {
    const owned = new Set((profile.languages || []).map((language) => language.toLowerCase()))
    if (!languages.some((language) => owned.has(language))) return false
  }

  const query = (params.get('query') || '').trim().toLocaleLowerCase('ru')
  if (query) {
    const hay = profileSearchText(profile)
    if (!query.split(/\s+/).every((word) => hay.includes(word))) return false
  }

  const sources = list(params, 'sources').map((source) => source.toLowerCase())
  if (sources.length && !sources.includes(profileSource(profile)) && !sources.includes(profileOrigin(profile))) return false

  const profileId = params.get('profileId') || params.get('listingId')
  if (profileId && profile.id !== profileId) return false

  // publicId is a one-way hash (source, country, id) stamped by
  // repairPublicFacts on every snapshot entry — a clean ?adv= link matches it
  // directly against the already-computed field instead of any raw identity.
  const publicId = params.get('publicId')
  if (publicId && String(profile.publicId ?? '') !== publicId) return false

  return true
}

function activityTimestamp(profile: CvProfile): number {
  const value = Date.parse(profile.activityAt || profile.updatedAt || profile.createdAt || '')
  return Number.isFinite(value) ? value : 0
}

function compareOptionalNumber(a: number | null | undefined, b: number | null | undefined, descending: boolean): number {
  const av = a == null || !Number.isFinite(a) ? null : a
  const bv = b == null || !Number.isFinite(b) ? null : b
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return descending ? bv - av : av - bv
}

function desiredSalary(profile: CvProfile, targetCurrency: string): number | null {
  const bounds = salaryBounds(profile, targetCurrency)
  return bounds ? Math.round((bounds.low + bounds.high) / 2) : null
}

function sortCandidateProfiles(profiles: CvProfile[], sort: string, salaryCurrency: string): void {
  const recent = (a: CvProfile, b: CvProfile) => activityTimestamp(b) - activityTimestamp(a)
  profiles.sort((a, b) => {
    let primary: number
    switch (sort) {
      case 'name_asc': {
        const an = (a.name || '').trim()
        const bn = (b.name || '').trim()
        if (!an && !bn) primary = 0
        else if (!an) primary = 1
        else if (!bn) primary = -1
        else primary = an.localeCompare(bn, undefined, { sensitivity: 'base' })
        break
      }
      case 'name_desc': {
        const an = (a.name || '').trim()
        const bn = (b.name || '').trim()
        if (!an && !bn) primary = 0
        else if (!an) primary = 1
        else if (!bn) primary = -1
        else primary = bn.localeCompare(an, undefined, { sensitivity: 'base' })
        break
      }
      case 'experience_desc': primary = compareOptionalNumber(a.experienceYears, b.experienceYears, true); break
      case 'experience_asc': primary = compareOptionalNumber(a.experienceYears, b.experienceYears, false); break
      case 'age_desc': primary = compareOptionalNumber(a.age, b.age, true); break
      case 'age_asc': primary = compareOptionalNumber(a.age, b.age, false); break
      case 'salary_desc': primary = compareOptionalNumber(desiredSalary(a, salaryCurrency), desiredSalary(b, salaryCurrency), true); break
      case 'salary_asc': primary = compareOptionalNumber(desiredSalary(a, salaryCurrency), desiredSalary(b, salaryCurrency), false); break
      default: primary = recent(a, b)
    }
    return primary || recent(a, b)
  })
}

const SNAPSHOT_TTL_MS = 60_000
let snapshotCache: CvProfile[] = []
let snapshotKey = ''
let snapshotAt = 0

function snapshotSignature(stored: CvProfile[]): string {
  const newest = stored.reduce((latest, profile) => {
    const activity = profile.activityAt || profile.updatedAt || profile.createdAt || ''
    return activity > latest ? activity : latest
  }, '')
  return `${stored.length}:${newest}:${stored[0]?.id || ''}:${stored[stored.length - 1]?.id || ''}`
}

function repairPublicFacts(profile: CvProfile): CvProfile {
  const professions = publicCandidateProfessionKeys(profile)
  return {
    ...profile,
    publicId: publicEntityId('candidate', profileSource(profile), profile.country, profile.id),
    ...publicCandidateSalary(profile),
    role: professions[0] || profile.role,
    professions: professions.length ? professions : profile.professions,
    gender: publicCandidateGender(profile),
    remote: publicCandidateRemote(profile),
  }
}

function normalizedSnapshot(stored: CvProfile[]): CvProfile[] {
  const key = snapshotSignature(stored)
  if (key === snapshotKey && Date.now() - snapshotAt < SNAPSHOT_TTL_MS) return snapshotCache
  snapshotCache = dedupeCandidates(stored.map((profile) => repairPublicFacts(
    profile.derived === DERIVED_VERSION ? profile : withProfessionExperience(normalizeCandidate(profile)),
  )))
  snapshotKey = key
  snapshotAt = Date.now()
  return snapshotCache
}

function sourceCounts(profiles: CvProfile[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const profile of profiles) {
    const key = profileSource(profile)
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function professionValues(): string[] {
  return collapseHiringProfessionFilterValues(Object.keys(HIRING_PROFESSION_LABELS))
    .sort((a, b) => a.localeCompare(b, 'en'))
}

function requestLocale(event: Parameters<typeof getCookie>[0]): HiringProfessionLocale {
  const cookieLocale = getCookie(event, 'i18n_lang')
  if (cookieLocale) return hiringProfessionLocale(cookieLocale)

  const referer = getRequestHeader(event, 'referer') || ''
  if (referer) {
    try {
      if (/^\/en(?:\/|$)/.test(new URL(referer).pathname)) return 'en'
    } catch {
      // Ignore malformed/relative referer and use the site default below.
    }
  }
  return 'ru'
}

function formatYears(years: number, locale: HiringProfessionLocale): string {
  if (years > 0 && years < 1) {
    const months = Math.max(1, Math.round(years * 12))
    if (locale === 'en') return `${months} ${months === 1 ? 'month' : 'months'}`
    const mod10 = months % 10
    const mod100 = months % 100
    const unit = mod10 === 1 && mod100 !== 11 ? 'месяц'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'месяца'
        : 'месяцев'
    return `${months} ${unit}`
  }
  if (locale === 'en') return `${years} ${years === 1 ? 'year' : 'years'}`
  const integer = Math.abs(Math.trunc(years))
  const mod10 = integer % 10
  const mod100 = integer % 100
  const unit = mod10 === 1 && mod100 !== 11 ? 'год'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'года'
      : 'лет'
  return `${years} ${unit}`
}

function previousExperienceSummary(profile: CvProfile, locale: HiringProfessionLocale): string[] {
  const byProfession = new Map(
    (profile.professionExperience || []).map((item) => [item.profession, item.years]),
  )
  return (profile.previousProfessions || []).map((profession) => {
    const label = hiringProfessionLabel(profession, locale)
    const years = byProfession.get(profession)
    return years == null ? label : `${label} — ${formatYears(years, locale)}`
  })
}

function convertedSalaryRange(
  profile: CvProfile,
  targetCurrency: string,
  locale: HiringProfessionLocale,
): string | null {
  const sourceCurrency = profile.currency?.trim().toUpperCase()
  if (!sourceCurrency || (profile.salaryMin == null && profile.salaryMax == null)) return null
  const min = convertCurrency(profile.salaryMin, sourceCurrency, targetCurrency)
  const max = convertCurrency(profile.salaryMax, sourceCurrency, targetCurrency)
  if (min == null && max == null) return null

  const number = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'ru-RU', { maximumFractionDigits: 0 })
  const low = min ?? max!
  const high = max ?? min!
  const range = low === high ? number.format(low) : `${number.format(Math.min(low, high))}–${number.format(Math.max(low, high))}`
  return targetCurrency === 'USD' ? `$${range}` : `${range} ${targetCurrency}`
}

function salaryDisplayCurrency(profile: CvProfile, locale: HiringProfessionLocale): string | null | undefined {
  const sourceCurrency = profile.currency?.trim().toUpperCase()
  if (!sourceCurrency || (profile.salaryMin == null && profile.salaryMax == null)) return profile.currency

  const localCurrency = HIRING_COUNTRIES.find((item) => item.code === profile.country?.toUpperCase())?.currency
  const suffixes: string[] = []
  if (localCurrency && localCurrency !== sourceCurrency) {
    const local = convertedSalaryRange(profile, localCurrency, locale)
    if (local) suffixes.push(`≈ ${local}`)
  }
  if (sourceCurrency !== 'USD') {
    const usd = convertedSalaryRange(profile, 'USD', locale)
    if (usd) suffixes.push(`≈ ${usd}`)
  }
  return suffixes.length ? `${sourceCurrency} · ${suffixes.join(' · ')}` : sourceCurrency
}

function publicProfile(profile: CvProfile, locale: HiringProfessionLocale): CvProfile {
  const localizeEmploymentType = (value: string): string => value === 'full_time'
    ? locale === 'en' ? 'Full-time' : 'Полная занятость'
    : value === 'part_time' ? locale === 'en' ? 'Part-time' : 'Частичная занятость' : value
  const localizeDetail = (value: string): string => {
    if (locale === 'en') return value
    if (value === 'No experience') return 'Без опыта'
    if (value === 'Student') return 'Студент'
    if (value === 'Minor') return 'Несовершеннолетний'
    if (value === 'Open to relocation') return 'Готов к переезду'
    if (value === 'Not open to relocation') return 'Не готов к переезду'
    if (value === 'Contact via source platform') return 'Контакт через платформу-источник'
    if (value === 'Web CV') return 'Веб-резюме'
    return value.replace(/^Age:\s*/u, 'Возраст: ').replace(/^District:\s*/u, 'Район: ')
  }
  const details = [...(profile.tags || [])].map(localizeDetail)
  for (const feature of profile.features || []) details.push(localizeDetail(feature))
  const previous = previousExperienceSummary(profile, locale)
  if (previous.length) details.push(`${locale === 'en' ? 'Previous experience' : 'Предыдущий опыт'}: ${previous.join(', ')}`)
  if (profile.district) details.push(localizeDetail(`District: ${profile.district}`))
  if (profile.age != null) details.push(localizeDetail(`Age: ${profile.age}`))
  if (profile.isAdult === false) details.push(localizeDetail('Minor'))
  if (profile.relocationReady === true) details.push(localizeDetail('Open to relocation'))
  if (profile.relocationReady === false) details.push(localizeDetail('Not open to relocation'))
  if (profile.contactType === 'platform' && profileOrigin(profile) !== 'telegram') details.push(localizeDetail('Contact via source platform'))

  const canonical = publicCandidateProfessionKeys(profile)
  return {
    ...profile,
    name: publicCandidateName(profile.name, locale),
    role: canonical.map((profession) => hiringProfessionLabel(profession, locale)).join(', '),
    professions: canonical,
    previousProfessions: (profile.previousProfessions || []).map((profession) => hiringProfessionLabel(profession, locale)),
    professionExperience: (profile.professionExperience || []).map((item) => ({
      ...item,
      profession: hiringProfessionLabel(item.profession, locale),
    })),
    gender: publicCandidateGender(profile),
    remote: publicCandidateRemote(profile),
    languages: publicCandidateLanguages(profile, locale),
    employmentType: profile.employmentTypes?.length
      ? profile.employmentTypes.map(localizeEmploymentType).join(', ')
      : profile.employmentType ? localizeEmploymentType(profile.employmentType) : profile.employmentType,
    education: hiringEducationLabel(profile.education, locale),
    currency: salaryDisplayCurrency(profile, locale),
    tags: [...new Set(details)].slice(0, 20),
    origin: profileOrigin(profile) as CvProfile['origin'],
    sourceKey: profileSource(profile),
    sourceLabel: profileProvider(profile),
  }
}

export default defineEventHandler(async (event) => {
  const incoming = getRequestURL(event)
  const params = incoming.searchParams
  const locale = requestLocale(event)
  const offset = Math.max(0, Number(params.get('offset')) || 0)
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(params.get('limit')) || 20))

  if (hiringDbEnabled()) {
    await loadRates()
    const databaseFeed = await queryDbCandidates(params, offset, limit)
    if (databaseFeed) {
      const [persistedSourceRuns] = await Promise.all([loadDbSourceRuns()])
      const sourceStatuses = getHiringSourceDiagnostics()
      const webStatusesByHandle = new Map(
        persistedSourceRuns
          .filter((item) => /^(?:web|social):/i.test(item.handle))
          .map((item) => [item.handle.toLowerCase(), item]),
      )
      for (const item of getHiringWebDiagnostics()) webStatusesByHandle.set(item.handle.toLowerCase(), item)
      const webSourceStatuses = [...webStatusesByHandle.values()].sort((a, b) => a.handle.localeCompare(b.handle))
      const sourceErrors = [
        ...sourceStatuses
          .filter((item) => item.status === 'error')
          .map((item) => ({ source: 'telegram', country: item.country, handle: item.handle, error: item.error || 'source failed' })),
        ...webSourceStatuses
          .filter((item) => item.status === 'error')
          .map((item) => ({
            source: 'key' in item ? item.key : item.handle.replace(/^(?:web|social):/i, ''),
            country: item.country,
            handle: item.handle,
            error: item.error || 'source failed',
          })),
      ]
      const counts = databaseFeed.sourceCounts
      setResponseHeader(event, 'Cache-Control', 'private, max-age=30')
      return {
        count: databaseFeed.count,
        profiles: databaseFeed.profiles.map((profile) => publicProfile(profile, locale)),
        statistics: databaseFeed.statistics,
        rates: getRates(),
        sourceCounts: counts,
        sourceStatuses,
        webSourceStatuses,
        sourceErrors,
        lastCrawlAt: [...persistedSourceRuns.map((run) => run.lastSuccessAt || ''), ...sourceStatuses.map((item) => item.checkedAt)]
          .filter(Boolean).sort().pop() || null,
        funnel: { parsed: 0, duplicate: 0, expired: 0, visibilityRejected: 0, shown: databaseFeed.count },
        warming: false,
        engine: 'postgresql',
        filters: {
          countries: params.get('countries') || '', city: params.get('city') || '', query: params.get('query') || '',
          remote: params.get('remote') || '', experienceMin: params.get('experienceMin') || '',
          salaryFrom: params.get('salaryFrom') || '', salaryTo: params.get('salaryTo') || '',
          salaryCurrency: params.get('salaryCurrency') || 'USD', sort: params.get('sort') || 'recent',
          ageMin: params.get('ageMin') || '', ageMax: params.get('ageMax') || '', gender: params.get('gender') || '',
          professions: params.get('professions') || '', seniority: params.get('seniority') || '',
          skills: params.get('skills') || '', languages: params.get('languages') || '', sources: params.get('sources') || '',
          offset, limit,
        },
        meta: {
          countries: HIRING_COUNTRIES,
          professions: professionValues(),
          sources: [
            ...(counts.telegram ? [{ value: 'telegram', label: 'Telegram', origin: 'telegram' as const }] : []),
            ...(counts.web ? [{ value: 'web', label: 'Web', origin: 'web' as const }] : []),
            ...(counts.facebook ? [{ value: 'facebook', label: 'Facebook', origin: 'facebook' as const }] : []),
            ...(counts.threads ? [{ value: 'threads', label: 'Threads', origin: 'threads' as const }] : []),
            ...[...listWebSources(), ...listUzJobsSources()]
              .filter((source) => (counts[source.key] || 0) > 0)
              .map((source) => ({ value: source.key, label: source.label, origin: 'web' as const })),
          ],
        },
      }
    }
  }

  const [telegramStored, webStored, persistedSourceRuns] = await Promise.all([
    getStoredCvProfilesSnapshot(),
    getStoredWebCvProfiles(),
    loadDbSourceRuns(),
    loadRates(),
  ])

  const storedByUrl = new Map<string, CvProfile>()
  for (const profile of [...telegramStored, ...webStored]) {
    storedByUrl.set(profile.url || profile.id, profile)
  }
  const profiles = normalizedSnapshot([...storedByUrl.values()])
  const byId = new Map(profiles.map((profile) => [profile.id, profile]))

  const query = (params.get('query') || '').trim()
  const needsMemoryFilters = Boolean(
    list(params, 'professions').length
    || params.get('ageMin')
    || params.get('ageMax')
    || params.get('gender')
    || params.get('salaryFrom')
    || params.get('salaryTo')
    || ((params.get('sort') || 'recent') !== 'recent'),
  )
  const professionQuery = query ? detectMentionedProfessions(query).length > 0 : false
  const hasWebProfiles = webStored.length > 0
  let page: CvProfile[] = []
  let statisticsProfiles: CvProfile[] = []
  let count = 0
  let engine: 'elasticsearch' | 'memory' = 'memory'

  if (query && !hasWebProfiles && !needsMemoryFilters && !professionQuery && (await candidateSearchAvailable())) {
    const result = await searchCandidates({
      query,
      countries: list(params, 'countries').map((code) => code.toUpperCase()),
      city: params.get('city') || undefined,
      skills: list(params, 'skills'),
      languages: list(params, 'languages'),
      seniority: (params.get('seniority') || '').trim().toLowerCase() || undefined,
      remote: params.get('remote') === '1' ? true : params.get('remote') === '0' ? false : undefined,
      experienceMin: Number(params.get('experienceMin')) || undefined,
      sources: list(params, 'sources'),
      from: offset,
      size: limit,
    })
    if (result) {
      engine = 'elasticsearch'
      count = result.total
      page = result.hits
        .map(({ id, score }) => {
          const profile = byId.get(id)
          return profile ? { ...profile, score } : null
        })
        .filter((profile): profile is CvProfile => profile != null)
      statisticsProfiles = profiles.filter((profile) => matchesFilters(profile, params))
    }
  }

  if (engine === 'memory') {
    const filtered = profiles.filter((profile) => matchesFilters(profile, params))
    sortCandidateProfiles(
      filtered,
      (params.get('sort') || 'recent').trim().toLowerCase(),
      (params.get('salaryCurrency') || 'USD').trim().toUpperCase(),
    )
    count = filtered.length
    statisticsProfiles = filtered
    page = filtered.slice(offset, offset + limit)
  }

  const sourceStatuses = getHiringSourceDiagnostics()
  const webStatusesByHandle = new Map(
    persistedSourceRuns
      .filter((item) => /^(?:web|social):/i.test(item.handle))
      .map((item) => [item.handle.toLowerCase(), item]),
  )
  for (const item of getHiringWebDiagnostics()) webStatusesByHandle.set(item.handle.toLowerCase(), item)
  const webSourceStatuses = [...webStatusesByHandle.values()]
    .sort((a, b) => a.handle.localeCompare(b.handle))
  const sourceErrors = [
    ...sourceStatuses
      .filter((item) => item.status === 'error')
      .map((item) => ({ source: 'telegram', country: item.country, handle: item.handle, error: item.error || 'source failed' })),
    ...webSourceStatuses
      .filter((item) => item.status === 'error')
      .map((item) => ({
        source: 'key' in item ? item.key : item.handle.replace(/^(?:web|social):/i, ''),
        country: item.country,
        handle: item.handle,
        error: item.error || 'source failed',
      })),
  ]

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    count,
    profiles: page.map((profile) => publicProfile(profile, locale)),
    statistics: buildHiringStatistics(statisticsProfiles, {
      provider: profileProvider,
      toUsd: (amount, currency) => convertCurrency(amount, currency, 'USD'),
    }),
    rates: getRates(),
    sourceCounts: sourceCounts(profiles),
    sourceStatuses,
    webSourceStatuses,
    sourceErrors,
    lastCrawlAt: [...persistedSourceRuns.map((run) => run.lastSuccessAt || ''), ...sourceStatuses.map((item) => item.checkedAt)]
      .filter(Boolean)
      .sort()
      .pop() || null,
    funnel: { parsed: 0, duplicate: 0, expired: 0, visibilityRejected: 0, shown: profiles.length },
    warming: false,
    engine,
    filters: {
      countries: params.get('countries') || '',
      city: params.get('city') || '',
      query: params.get('query') || '',
      remote: params.get('remote') || '',
      experienceMin: params.get('experienceMin') || '',
      salaryFrom: params.get('salaryFrom') || '',
      salaryTo: params.get('salaryTo') || '',
      salaryCurrency: params.get('salaryCurrency') || 'USD',
      sort: params.get('sort') || 'recent',
      ageMin: params.get('ageMin') || '',
      ageMax: params.get('ageMax') || '',
      gender: params.get('gender') || '',
      professions: params.get('professions') || '',
      seniority: params.get('seniority') || '',
      skills: params.get('skills') || '',
      languages: params.get('languages') || '',
      sources: params.get('sources') || '',
      offset,
      limit,
    },
    meta: {
      countries: HIRING_COUNTRIES,
      professions: professionValues(),
      sources: [
        ...(profiles.some((profile) => profileOrigin(profile) === 'telegram')
          ? [{ value: 'telegram', label: 'Telegram', origin: 'telegram' }]
          : []),
        ...(profiles.some((profile) => profileOrigin(profile) === 'web')
          ? [{ value: 'web', label: 'Web', origin: 'web' }]
          : []),
        ...(profiles.some((profile) => profileOrigin(profile) === 'facebook')
          ? [{ value: 'facebook', label: 'Facebook', origin: 'facebook' }]
          : []),
        ...(profiles.some((profile) => profileOrigin(profile) === 'threads')
          ? [{ value: 'threads', label: 'Threads', origin: 'threads' }]
          : []),
        ...[...listWebSources(), ...listUzJobsSources()]
          .filter((source) => (sourceCounts(profiles)[source.key] || 0) > 0)
          .map((source) => ({ value: source.key, label: source.label, origin: 'web' as const })),
      ],
    },
  }
})
