// Semantic text enrichment for vacancies, via the shared ai-worker.
//
// Mirrors the candidate flow in hiring/: the deterministic enrichers stay
// authoritative and this layer only fills fields they left empty. Job posts
// state schedules, seniority and language requirements in prose that no
// keyword list covers, but a salary or a contact the parser already extracted
// is never replaced by a model guess.
//
// If the worker is disabled, slow, failing or low-confidence, jobs keep exactly
// what the deterministic pipeline produced.

import type { Job, LanguageReq, Seniority, SalaryPeriod, WorkMode } from '../../../shared/contracts/jobs'
import {
  aiFingerprint,
  aiWorkerEnabled,
  scheduleAiExtraction,
  type AiExtractionResult,
} from '../../utils/support/aiWorker'

// Bump when prompts, schema or merge rules change, so already-enriched
// vacancies are re-evaluated instead of keeping an answer from the old contract.
export const VACANCY_PARSER_VERSION = 'vacancy-semantic-v1'

const MIN_CONFIDENCE = Number(process.env.AI_WORKER_VACANCY_MIN_CONFIDENCE) || 0.6

export type VacancyAiData = {
  title?: string | null
  company?: string | null
  salaryMin?: number | null
  salaryMax?: number | null
  currency?: string | null
  salaryPeriod?: string | null
  employmentType?: string | null
  workFormat?: string | null
  experienceMinYears?: number | null
  experienceMaxYears?: number | null
  skills?: string[]
  languages?: Array<{ language: string, level?: string | null, required?: boolean | null }>
  relocationSupport?: boolean | null
  foreignersAccepted?: boolean | null
  salaryGross?: boolean | null
  salaryNegotiable?: boolean | null
  seniority?: string | null
  schedule?: string | null
  contractType?: string | null
  education?: string | null
  managementRole?: boolean | null
  deadline?: string | null
  niceToHave?: string[]
  tools?: string[]
  applicationLanguage?: string | null
}

export type VacancyAiState = {
  parserVersion: string
  fingerprint: string
  status: 'pending' | 'completed' | 'low_confidence' | 'failed' | 'unavailable'
  confidence?: number
  derivedFields?: string[]
  updatedAt: string
}

type EnrichableJob = Job & { ai?: unknown }

// Scalar fields whose model name and Job name mean the same thing.
const SCALAR_FIELDS: ReadonlyArray<[keyof VacancyAiData, keyof Job]> = [
  ['salaryMin', 'salaryMin'],
  ['salaryMax', 'salaryMax'],
  ['currency', 'salaryCurrency'],
  ['experienceMinYears', 'experienceMinYears'],
  ['experienceMaxYears', 'experienceMaxYears'],
  ['employmentType', 'employmentType'],
  ['salaryGross', 'salaryGross'],
  ['salaryNegotiable', 'salaryNegotiable'],
  ['schedule', 'schedule'],
  ['contractType', 'contractType'],
  ['education', 'education'],
  ['managementRole', 'managementRole'],
  ['deadline', 'deadline'],
  ['applicationLanguage', 'applicationLanguage'],
  ['foreignersAccepted', 'foreignerFriendly'],
]

const LIST_FIELDS: ReadonlyArray<[keyof VacancyAiData, keyof Job]> = [
  ['skills', 'skills'],
  ['niceToHave', 'niceToHave'],
  ['tools', 'tools'],
]

// Deterministic facts handed to the model so it corroborates rather than
// contradicts, and so a changed parse invalidates the cached answer.
const KNOWN_FACT_FIELDS: ReadonlyArray<keyof Job> = [
  'title', 'company', 'location', 'country', 'city', 'remote',
  'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'employmentType',
]

const SENIORITY_VALUES = new Set<Seniority>(['junior', 'middle', 'senior', 'lead'])
const SALARY_PERIODS = new Set<SalaryPeriod>(['hour', 'day', 'week', 'month', 'year'])
const WORK_MODES: Record<string, WorkMode> = { office: 'office', remote: 'remote', hybrid: 'hybrid' }

function blank(value: unknown): boolean {
  return value == null || value === ''
}

function emptyList(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0
}

export function vacancyAiText(job: Job): string {
  return `${job?.title || ''}\n${job?.description || ''}`.trim()
}

export function vacancyAiInput(job: Job) {
  const rawText = vacancyAiText(job)
  const knownFacts: Record<string, unknown> = {}
  for (const field of KNOWN_FACT_FIELDS) {
    knownFacts[field] = blank(job?.[field]) ? null : job[field]
  }
  return {
    rawText,
    knownFacts,
    fingerprint: aiFingerprint('vacancy', rawText, {
      parserVersion: VACANCY_PARSER_VERSION,
      ...knownFacts,
    }),
  }
}

export function needsVacancyAi(job: Job): boolean {
  if (!job || !vacancyAiText(job)) return false
  // Only real vacancies: digests, courses and recruitment ads are filtered
  // upstream and must not spend inference budget.
  if (job.hiringKind && job.hiringKind !== 'vacancy') return false

  return SCALAR_FIELDS.some(([, field]) => blank(job[field]))
    || LIST_FIELDS.some(([, field]) => emptyList(job[field]))
    || blank(job.seniority)
    || emptyList(job.languages)
}

function acceptedLanguages(values: VacancyAiData['languages']): LanguageReq[] {
  return (values || [])
    .filter((item) => item && typeof item.language === 'string' && item.language.trim())
    .map((item) => ({
      language: item.language.trim(),
      ...(blank(item.level) ? {} : { level: String(item.level) }),
      ...(item.required == null
        ? {}
        : { requirement: (item.required ? 'required' : 'notRequired') as LanguageReq['requirement'] }),
    }))
}

/**
 * Fills empty Job fields from a validated model answer. Existing values are
 * never overwritten, and every field the model supplied is recorded so the API
 * can tell a parsed value from an inferred one.
 */
export function mergeVacancyAi<T extends EnrichableJob>(job: T, result: AiExtractionResult<VacancyAiData>): T {
  const data = result?.data || {}
  const merged: T = { ...job }
  const derivedFields = new Set<string>()

  for (const [aiField, jobField] of SCALAR_FIELDS) {
    const value = data[aiField]
    if (!blank(merged[jobField]) || blank(value)) continue
    ;(merged as Record<string, unknown>)[jobField] = value
    derivedFields.add(String(jobField))
  }

  for (const [aiField, jobField] of LIST_FIELDS) {
    const value = data[aiField]
    if (!emptyList(merged[jobField]) || emptyList(value)) continue
    const items = [...new Set((value as string[]).map((item) => String(item).trim()).filter(Boolean))]
    if (!items.length) continue
    ;(merged as Record<string, unknown>)[jobField] = items
    derivedFields.add(String(jobField))
  }

  // Enum-typed fields only accept a value the contract actually declares.
  if (blank(merged.seniority) && SENIORITY_VALUES.has(data.seniority as Seniority)) {
    merged.seniority = data.seniority as Seniority
    derivedFields.add('seniority')
  }
  if (blank(merged.salaryPeriod) && SALARY_PERIODS.has(data.salaryPeriod as SalaryPeriod)) {
    merged.salaryPeriod = data.salaryPeriod as SalaryPeriod
    derivedFields.add('salaryPeriod')
  }
  // "field" work has no contract equivalent, so it is dropped rather than
  // squeezed into the nearest mode.
  const workMode = WORK_MODES[String(data.workFormat || '')]
  if ((blank(merged.workMode) || merged.workMode === 'unknown') && workMode) {
    merged.workMode = workMode
    derivedFields.add('workMode')
  }
  if (blank(merged.relocation) || merged.relocation === 'unknown') {
    if (data.relocationSupport === true) {
      merged.relocation = 'offered'
      derivedFields.add('relocation')
    } else if (data.relocationSupport === false) {
      merged.relocation = 'none'
      derivedFields.add('relocation')
    }
  }

  if (emptyList(merged.languages)) {
    const languages = acceptedLanguages(data.languages)
    if (languages.length) {
      merged.languages = languages
      derivedFields.add('languages')
    }
  }

  merged.ai = {
    parserVersion: VACANCY_PARSER_VERSION,
    fingerprint: (job.ai as VacancyAiState | undefined)?.fingerprint ?? '',
    status: 'completed',
    confidence: Number(result?.confidence) || 0,
    derivedFields: [...derivedFields].sort(),
    updatedAt: new Date().toISOString(),
  } satisfies VacancyAiState

  return merged
}

function state(fingerprint: string, status: VacancyAiState['status'], confidence?: number): VacancyAiState {
  return {
    parserVersion: VACANCY_PARSER_VERSION,
    fingerprint,
    status,
    ...(confidence == null ? {} : { confidence }),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Queues vacancy extraction for jobs the deterministic pipeline left
 * incomplete. `persist` receives the merged job; callers own storage.
 */
export function scheduleVacancyAi<T extends EnrichableJob>(
  jobs: T[],
  persist?: (job: T) => void | Promise<void>,
): number {
  if (!aiWorkerEnabled() || !Array.isArray(jobs) || !jobs.length) return 0

  const batchSize = Math.max(1, Number(process.env.AI_WORKER_VACANCY_BATCH) || 12)
  let queued = 0

  for (const job of jobs) {
    if (queued >= batchSize) break
    if (!needsVacancyAi(job)) continue

    const input = vacancyAiInput(job)
    // Same text and same deterministic facts as last time: nothing to re-ask.
    if ((job.ai as VacancyAiState | undefined)?.fingerprint === input.fingerprint) continue

    const accepted = scheduleAiExtraction<VacancyAiData>({
      id: job.id,
      kind: 'vacancy',
      rawText: input.rawText,
      knownFacts: input.knownFacts,
      fingerprint: input.fingerprint,
      meta: { source: job.source, id: job.id, country: job.country, url: job.url },
      onResult: async (result) => {
        if (result?.lowConfidence || (Number(result?.confidence) || 0) < MIN_CONFIDENCE) {
          job.ai = state(input.fingerprint, 'low_confidence', Number(result?.confidence) || 0)
          return
        }
        const merged = mergeVacancyAi(job, result)
        ;(merged.ai as VacancyAiState).fingerprint = input.fingerprint
        await persist?.(merged)
      },
      onFailed: (status) => {
        job.ai = state(input.fingerprint, status === 'failed' ? 'failed' : 'unavailable')
      },
    })

    if (accepted) {
      job.ai = state(input.fingerprint, 'pending')
      queued += 1
    }
  }

  if (queued) console.log(`[jobs:ai] queued vacancy extraction=${queued}`)
  return queued
}
