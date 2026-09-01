import { useStateStore } from '~~/server/utils/stateStore'
import { syncJobsDb } from '../../jobs/infrastructure/database'
import {
  configuredAviationJobTargets,
  fetchAviationJobTarget,
  isAviationJobTarget,
} from '../../utils/aviationExpansionJobs'
import {
  configuredCommunityJobBoardTargets,
  fetchCommunityJobBoardTarget,
  isCommunityJobBoardTarget,
} from '../../utils/communityJobBoardSources'
import {
  configuredCoreCompanyTargets,
  fetchCoreCompanyTarget,
  isCoreCompanyTarget,
} from '../../utils/coreCompanyJobTargets'
import {
  configuredCuratedRemoteJobBoardTargets,
  fetchCuratedRemoteJobBoardTarget,
  isCuratedRemoteJobBoardTarget,
} from '../../utils/curatedRemoteJobBoardTargets'
import { enrichJob } from '../domain/enrich'
import {
  configuredExpandedRegionalRemoteTargets,
  fetchExpandedRegionalRemoteTarget,
  isExpandedRegionalRemoteTarget,
} from '../../utils/expandedRegionalRemoteSources'
import {
  configuredHhJobTargets,
  fetchHhJobTarget,
  isHhJobTarget,
} from '../../utils/hhJobSource'
import { fetchIntelliasJobs } from '../../utils/intelliasJobs'
import { isJobSourceAvailable } from '../../utils/jobSourceConfig'
import { fetchJobSource } from '../../utils/jobSourceFetchers'
import { syncJobsSearchIndex } from '../infrastructure/jobsElastic'
import type { Job, JobSource } from '~~/shared/contracts/jobs'
import { ALL_SOURCES } from '~~/shared/contracts/jobs'
import { fetchJobsUaJobs } from '../../utils/jobsUaSource'
import {
  configuredLinkedInJobTargets,
  fetchLinkedInJobTarget,
  isLinkedInJobTarget,
} from '../../utils/linkedinSource'
import {
  configuredPublicJobBoardTargets,
  fetchPublicJobBoardTarget,
  isPublicJobBoardTarget,
} from '../../utils/publicJobBoardTargets'
import {
  configuredRegionalGeneralEmployerTargets,
  fetchRegionalGeneralEmployerTarget,
  isRegionalGeneralEmployerTarget,
} from '../../utils/regionalGeneralEmployerSources'
import {
  configuredRegionalJobBoardTargets,
  fetchRegionalJobBoardTarget,
  isRegionalJobBoardTarget,
} from '../../utils/regionalJobBoardSources'
import {
  configuredRegionalServiceJobTargets,
  fetchRegionalServiceJobTarget,
  isRegionalServiceJobTarget,
} from '../../utils/regionalServiceJobSources'
import {
  configuredRegionalTechCompanyTargets,
  fetchRegionalTechCompanyTarget,
  isRegionalTechCompanyTarget,
} from '../../utils/regionalTechCompanySources'
import {
  configuredSocialJobTargets,
  fetchSocialJobTarget,
  isSocialJobTarget,
  sourceForSocialJobTarget,
} from '../sources/socialJobSources'
import {
  configuredSourceExpansionTargets,
  fetchSourceExpansionTarget,
  isSourceExpansionTarget,
} from '../../utils/sourceExpansionJobs'
import {
  configuredStandardJobSourceTargets,
  fetchStandardJobSourceTarget,
  isStandardJobSourceTarget,
  sourceForStandardJobSourceTarget,
} from '../../utils/standardJobSourceTargets'
import {
  configuredTelegramJobTargets,
  fetchTelegramJobTarget,
  isTelegramJobTarget,
} from '../sources/telegramJobTargets'
import { isLikelyTelegramVacancy } from '../sources/telegramVacancyClassifier'
import {
  configuredUkraineJobTargets,
  fetchUkraineJobTarget,
  isUkraineJobTarget,
} from '../../utils/ukraineJobSources'
import {
  configuredUsaTechCompanyTargets,
  fetchUsaTechCompanyTarget,
  isUsaTechCompanyTarget,
} from '../../utils/usaTechCompanySources'
import {
  configuredUsaVisaSponsorTargets,
  fetchUsaVisaSponsorTarget,
  isUsaVisaSponsorTarget,
} from '../../utils/usaVisaSponsorSource'

const STORE_KEY = 'jobs:store:v4'
const STORE_TTL_SECONDS = 15 * 86_400
const MAX_AGE_DAYS = 14
const STALE_DAYS = 4
const COMPANY_SOURCE_TARGET_PREFIX = 'company-source:'
const COMPANY_SOURCE_TARGETS = ['intellias', 'jobs-ua'] as const
const TARGETIZED_SOURCES = new Set<JobSource>([
  'companies',
  'themuse',
  'hh',
  'adzuna',
  'jooble',
  'rss',
  'linkedin',
  'facebook',
  'threads',
  'ishgo',
  'itjobsuz',
  'telegram',
  'olx',
])

type StoredJob = Job & {
  lastSeen: string
  ai?: unknown
}

type CompanySourceTarget = typeof COMPANY_SOURCE_TARGETS[number]

function normalizedTagKey(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}+#.]+/gu, ' ').trim().toLocaleLowerCase('en')
}

function cleanJobTags(job: Job): Job {
  const company = normalizedTagKey(job.company || '')
  const seen = new Set<string>()
  const tags = (job.tags || []).filter((tag) => {
    const key = normalizedTagKey(String(tag || ''))
    if (!key || key === company || seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (tags.length === (job.tags || []).length) return job
  return { ...job, tags }
}

export function sanitizeFetchedJob(input: Job): Job {
  const job = cleanJobTags(input)
  const raw = String(job.description || '').replace(/\s+/g, ' ').trim()
  if (!raw) return job

  const embeddedScript = raw.search(
    /(?:window\.yaContextCb\b|Ya\.Context\.AdvManager\b|yandex_rtb_R-A-\d+|googletag\.cmd\b|dataLayer\.push\s*\()/i,
  )
  let description = embeddedScript >= 0 ? raw.slice(0, embeddedScript).trim() : raw

  const isIshBor = (job.tags || []).some((tag) => /ish-bor\.uz/i.test(String(tag)))
    || /ish-bor\.uz/i.test(job.company || '')
    || /ish-bor\.uz/i.test(job.url || '')

  if (isIshBor) {
    description = description
      .replace(/^Регистрация\s+\d{1,2}[./-]\d{1,2}[./-]20\d{2}(?:\s+\d+){0,3}\s*/iu, '')
      .replace(/\s+\|?\s*Вакансии,\s*Вакансия,\s*работа(?:\s|,|$)[\s\S]*$/iu, '')
      .replace(/\s+ish-bor\.uz\s+(?:Фильтр|Если вам нужна работа|Меню|О нас)[\s\S]*$/iu, '')
      .trim()
    if (!description || /^Регистрация(?:\s|$)/iu.test(description)) description = job.title.trim()
  }

  return description === raw ? job : { ...job, description: description || undefined }
}

let mergeLock: Promise<unknown> = Promise.resolve()

export function configuredJobSources(): JobSource[] {
  return ALL_SOURCES.filter((source) => isJobSourceAvailable(source, 'ingestion'))
}

function companySourceTarget(key: CompanySourceTarget): string {
  return `${COMPANY_SOURCE_TARGET_PREFIX}${key}`
}

function isCompanySourceTarget(target: string): target is `${typeof COMPANY_SOURCE_TARGET_PREFIX}${CompanySourceTarget}` {
  if (!target.startsWith(COMPANY_SOURCE_TARGET_PREFIX)) return false
  return COMPANY_SOURCE_TARGETS.includes(target.slice(COMPANY_SOURCE_TARGET_PREFIX.length) as CompanySourceTarget)
}

function configuredCompanyTargets(): string[] {
  if (!isJobSourceAvailable('companies', 'ingestion')) return []
  return [
    ...configuredCoreCompanyTargets(),
    ...configuredCommunityJobBoardTargets(),
    ...configuredPublicJobBoardTargets(),
    ...configuredCuratedRemoteJobBoardTargets(),
    ...configuredExpandedRegionalRemoteTargets(),
    ...configuredRegionalGeneralEmployerTargets(),
    ...configuredRegionalServiceJobTargets(),
    ...configuredUsaTechCompanyTargets(),
    ...configuredRegionalTechCompanyTargets(),
    ...configuredRegionalJobBoardTargets(),
    ...configuredAviationJobTargets(),
    ...configuredUsaVisaSponsorTargets(),
    ...configuredSourceExpansionTargets(),
    ...configuredUkraineJobTargets(),
    ...COMPANY_SOURCE_TARGETS.map(companySourceTarget),
  ]
}

export function configuredJobRefreshTargets(): string[] {
  const directSources = configuredJobSources().filter((source) => !TARGETIZED_SOURCES.has(source))
  const standardTargets = configuredStandardJobSourceTargets().filter((target) => {
    const source = sourceForStandardJobSourceTarget(target)
    return Boolean(source && isJobSourceAvailable(source, 'ingestion'))
  })
  const socialTargets = configuredSocialJobTargets().filter((target) => {
    const source = sourceForSocialJobTarget(target)
    return Boolean(source && isJobSourceAvailable(source, 'ingestion'))
  })

  return [
    ...directSources,
    ...configuredCompanyTargets(),
    ...(isJobSourceAvailable('hh', 'ingestion') ? configuredHhJobTargets() : []),
    ...standardTargets,
    ...(isJobSourceAvailable('linkedin', 'ingestion') ? configuredLinkedInJobTargets() : []),
    ...socialTargets,
    ...(isJobSourceAvailable('telegram', 'ingestion') ? configuredTelegramJobTargets() : []),
  ]
}

function dedupKey(job: Job): string {
  return job.url || job.id
}

function isVisible(job: StoredJob): boolean {
  return job.source !== 'telegram'
    || isLikelyTelegramVacancy(`${job.title}\n${job.description || ''}`)
}

function prune(list: StoredJob[], now: number): StoredJob[] {
  const oldestPosted = now - MAX_AGE_DAYS * 86_400_000
  const stalest = now - STALE_DAYS * 86_400_000
  return list.filter((job) => {
    if (!isVisible(job)) return false
    const posted = Date.parse(job.postedAt)
    const seen = Date.parse(job.lastSeen)
    if (Number.isNaN(posted) || posted < oldestPosted) return false
    if (Number.isNaN(seen) || seen < stalest) return false
    return true
  })
}

async function mergeFetchedSource(source: JobSource, jobs: Job[]) {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const store = useStateStore()
  const raw = await store.get(STORE_KEY)
  const existing = raw ? JSON.parse(raw) as StoredJob[] : []
  const byKey = new Map<string, StoredJob>()

  for (const stored of existing) {
    const job = sanitizeFetchedJob(stored) as StoredJob
    byKey.set(dedupKey(job), job)
  }

  for (const job of jobs) {
    if (job.vacancyStatus === 'closed' || job.hiringKind === 'closed_vacancy') {
      byKey.delete(dedupKey(job))
      continue
    }
    const enriched = enrichJob(sanitizeFetchedJob(job))
    const key = dedupKey(enriched)
    const previous = byKey.get(key)
    byKey.set(key, {
      ...enriched,
      lastSeen: nowIso,
      ...(previous?.ai ? { ai: previous.ai } : {}),
    })
  }

  const kept = prune([...byKey.values()], now)
  await store.set(STORE_KEY, JSON.stringify(kept), 'EX', STORE_TTL_SECONDS)

  try {
    await syncJobsSearchIndex(kept)
  } catch (error) {
    console.error(`[jobs:queue:${source}] Elasticsearch sync failed:`, (error as Error).message)
  }
  try {
    await syncJobsDb(kept)
  } catch (error) {
    console.error(`[jobs:queue:${source}] PostgreSQL sync failed:`, (error as Error).message)
  }

  return { source, fetched: jobs.length, stored: kept.length }
}

const inFlight = new Map<string, Promise<unknown>>()

function isKnownJobSource(value: string): value is JobSource {
  return ALL_SOURCES.includes(value as JobSource)
}

function isCompanyQueueTarget(target: string): boolean {
  return isCoreCompanyTarget(target)
    || isCommunityJobBoardTarget(target)
    || isPublicJobBoardTarget(target)
    || isCuratedRemoteJobBoardTarget(target)
    || isExpandedRegionalRemoteTarget(target)
    || isRegionalGeneralEmployerTarget(target)
    || isRegionalServiceJobTarget(target)
    || isUsaTechCompanyTarget(target)
    || isRegionalTechCompanyTarget(target)
    || isRegionalJobBoardTarget(target)
    || isAviationJobTarget(target)
    || isUsaVisaSponsorTarget(target)
    || isSourceExpansionTarget(target)
    || isUkraineJobTarget(target)
    || isCompanySourceTarget(target)
}

function isKnownRefreshTarget(target: string): boolean {
  return isKnownJobSource(target)
    || isCompanyQueueTarget(target)
    || isHhJobTarget(target)
    || isStandardJobSourceTarget(target)
    || isLinkedInJobTarget(target)
    || isSocialJobTarget(target)
    || isTelegramJobTarget(target)
}

async function mergeForTarget(target: string, source: JobSource, jobs: Job[]) {
  const operation = mergeLock.then(
    () => mergeFetchedSource(source, jobs),
    () => mergeFetchedSource(source, jobs),
  )
  mergeLock = operation.catch(() => {})
  const result = await operation
  return { target, ...result }
}

async function fetchCompanyQueueTarget(target: string): Promise<Job[]> {
  if (isCoreCompanyTarget(target)) return fetchCoreCompanyTarget(target)
  if (isCommunityJobBoardTarget(target)) return fetchCommunityJobBoardTarget(target)
  if (isPublicJobBoardTarget(target)) return fetchPublicJobBoardTarget(target)
  if (isCuratedRemoteJobBoardTarget(target)) return fetchCuratedRemoteJobBoardTarget(target)
  if (isExpandedRegionalRemoteTarget(target)) return fetchExpandedRegionalRemoteTarget(target)
  if (isRegionalGeneralEmployerTarget(target)) return fetchRegionalGeneralEmployerTarget(target)
  if (isRegionalServiceJobTarget(target)) return fetchRegionalServiceJobTarget(target)
  if (isUsaTechCompanyTarget(target)) return fetchUsaTechCompanyTarget(target)
  if (isRegionalTechCompanyTarget(target)) return fetchRegionalTechCompanyTarget(target)
  if (isRegionalJobBoardTarget(target)) return fetchRegionalJobBoardTarget(target)
  if (isAviationJobTarget(target)) return fetchAviationJobTarget(target)
  if (isUsaVisaSponsorTarget(target)) return fetchUsaVisaSponsorTarget(target)
  if (isSourceExpansionTarget(target)) return fetchSourceExpansionTarget(target)
  if (isUkraineJobTarget(target)) return fetchUkraineJobTarget(target)
  if (isCompanySourceTarget(target)) {
    const key = target.slice(COMPANY_SOURCE_TARGET_PREFIX.length) as CompanySourceTarget
    if (key === 'intellias') return fetchIntelliasJobs('')
    if (key === 'jobs-ua') return fetchJobsUaJobs('')
  }
  throw new Error(`Unknown company queue target ${target}`)
}

async function runJobTargetRefresh(target: string) {
  if (isCompanyQueueTarget(target)) {
    if (!isJobSourceAvailable('companies', 'ingestion')) {
      return { target, source: 'companies' as const, skipped: true, reason: 'not_configured', fetched: 0 }
    }
    return mergeForTarget(target, 'companies', await fetchCompanyQueueTarget(target))
  }

  if (isHhJobTarget(target)) {
    if (!isJobSourceAvailable('hh', 'ingestion')) {
      return { target, source: 'hh' as const, skipped: true, reason: 'not_configured', fetched: 0 }
    }
    return mergeForTarget(target, 'hh', await fetchHhJobTarget(target))
  }

  if (isStandardJobSourceTarget(target)) {
    const source = sourceForStandardJobSourceTarget(target)
    if (!source) throw new Error(`Unknown standard job source target ${target}`)
    if (!isJobSourceAvailable(source, 'ingestion')) {
      return { target, source, skipped: true, reason: 'not_configured', fetched: 0 }
    }
    const result = await fetchStandardJobSourceTarget(target)
    return mergeForTarget(target, source, result.jobs)
  }

  if (isLinkedInJobTarget(target)) {
    if (!isJobSourceAvailable('linkedin', 'ingestion')) {
      return { target, source: 'linkedin' as const, skipped: true, reason: 'not_configured', fetched: 0 }
    }
    return mergeForTarget(target, 'linkedin', await fetchLinkedInJobTarget(target))
  }

  if (isSocialJobTarget(target)) {
    const source = sourceForSocialJobTarget(target)
    if (!source) throw new Error(`Unknown social job target ${target}`)
    if (!isJobSourceAvailable(source, 'ingestion')) {
      return { target, source, skipped: true, reason: 'not_configured', fetched: 0 }
    }
    return mergeForTarget(target, source, await fetchSocialJobTarget(target))
  }

  if (isTelegramJobTarget(target)) {
    if (!isJobSourceAvailable('telegram', 'ingestion')) {
      return { target, source: 'telegram' as const, skipped: true, reason: 'not_configured', fetched: 0 }
    }
    return mergeForTarget(target, 'telegram', await fetchTelegramJobTarget(target))
  }

  if (!isKnownJobSource(target)) throw new Error(`Unknown job refresh target ${target}`)
  if (TARGETIZED_SOURCES.has(target)) {
    return { target, source: target, skipped: true, reason: 'use_queue_targets', fetched: 0 }
  }
  if (!isJobSourceAvailable(target, 'ingestion')) {
    return { target, source: target, skipped: true, reason: 'not_configured', fetched: 0 }
  }
  return mergeForTarget(target, target, await fetchJobSource(target))
}

export async function refreshJobTarget(target: string) {
  if (!isKnownRefreshTarget(target)) throw new Error(`Unknown job refresh target ${target}`)
  if (inFlight.has(target)) {
    console.log(`[jobs] ${target} refresh already running; skipping this request`)
    return { target, skipped: true, reason: 'already_running', fetched: 0 }
  }

  const started = runJobTargetRefresh(target)
  inFlight.set(target, started)
  try {
    return await started
  } finally {
    inFlight.delete(target)
  }
}

export async function refreshJobSource(source: JobSource) {
  return refreshJobTarget(source)
}
