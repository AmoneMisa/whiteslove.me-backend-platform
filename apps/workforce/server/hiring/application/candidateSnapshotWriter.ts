import { useStateStore } from '~~/server/utils/support/stateStore'
import { isLikelyCvPost } from '../domain/telegramCandidateParser'
import { mentionsEmploymentOrSchedule, normalizeCandidate } from '../../utils/hiring/hiringNormalize'
import { withProfessionExperience } from '../../utils/hiring/hiringExperience'
import { isCharityAppeal, isRecruitingOpportunity, repairCandidateProfile } from '../../utils/hiring/hiringQuality'
import {
  aiFingerprint,
  aiWorkerEnabled,
  scheduleAiExtraction,
  type AiExtractionResult,
} from '../../utils/support/aiWorker'
import { hiringDbEnabled, loadDbCandidates, saveDbCandidates } from '../infrastructure/database'
import { withHiringStoreLock } from '../infrastructure/storeLock'
import type { CandidateEmploymentType, CvProfile } from '../../../shared/contracts/hiring'
import type { SourceRun } from '../../../shared/hiring/hiringDiagnostics'

const STORE_KEY = 'hiring:store:v4'
const STORE_TTL_SECONDS = 100 * 86_400
const MAX_AGE_MONTHS = 3
const AI_MIN_CONFIDENCE = 0.7
const AI_CANDIDATE_PARSER_VERSION = 'candidate-semantic-v2'
const AI_FAILED_RETRY_MS = 15 * 60_000
const AI_PENDING_STALE_MS = 30 * 60_000
const DB_HYDRATE_COOLDOWN_MS = 60_000
const DERIVED_VERSION = 'd19'

type CandidateAiData = {
  name?: string | null
  professions?: string[]
  previousProfessions?: string[]
  skills?: string[]
  features?: string[]
  age?: number | null
  isAdult?: boolean | null
  salaryMin?: number | null
  salaryMax?: number | null
  currency?: string | null
  country?: string | null
  city?: string | null
  district?: string | null
  remote?: boolean | null
  relocationReady?: boolean | null
  employmentTypes?: CandidateEmploymentType[]
  experienceYears?: number | null
  education?: string | null
  languages?: string[]
  contacts?: { telegram?: string | null; email?: string | null; phone?: string | null }
}

type StoredAi = {
  fingerprint: string
  status: 'pending' | 'completed' | 'low_confidence' | 'failed'
  confidence?: number
  data?: CandidateAiData
  updatedAt: string
}

type StoredProfile = CvProfile & {
  lastSeen: string
  ai?: StoredAi
  derived?: string
  visible?: boolean
}

let memoryStore: StoredProfile[] = []
let dbHydratedAt = 0

function dedupKey(profile: CvProfile): string {
  return profile.url || profile.id
}

function repaired(profile: CvProfile): CvProfile {
  return repairCandidateProfile(normalizeCandidate(profile))
}

function channelHandle(profile: CvProfile): string {
  return /^https?:\/\/t\.me\/([^/]+)/i.exec(profile.url || '')?.[1]?.toLowerCase() || ''
}

async function hydrateFromDb(): Promise<StoredProfile[]> {
  if (!hiringDbEnabled() || Date.now() - dbHydratedAt < DB_HYDRATE_COOLDOWN_MS) return []
  dbHydratedAt = Date.now()
  const profiles = await loadDbCandidates()
  if (!profiles.length) return []
  const nowIso = new Date().toISOString()
  const restored = profiles.map((profile) => ({ ...profile, lastSeen: nowIso }))
  console.log(`[hiring:db] hydrated ${restored.length} candidates from postgres`)
  await persistStore(restored)
  return restored
}

/**
 * Community channels also publish workshops, webinars and educational events.
 * Such posts can mention a recruiter, years of experience and AI tooling, which
 * used to satisfy generic CV heuristics. Require two independent event signals
 * so a real CV that merely mentions attending a course is not discarded.
 */
export function isCandidateEventPromotion(text: string): boolean {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return false
  const signals = [
    /(?:воркшоп\p{L}*|workshops?|вебінар\p{L}*|вебинар\p{L}*|webinars?|майстер[- ]?клас\p{L}*|мастер[- ]?класс\p{L}*)/iu,
    /(?:сері(?:я|ї)\s+практичн\p{L}*|серия\s+практическ\p{L}*|що\s+буде\s+на\s+воркшоп|что\s+будет\s+на\s+воркшоп|workshop\s+(?:agenda|program))/iu,
    /(?:\d{1,2}\s+\p{L}+\s+(?:стартує|стартует|починається|начинается)|(?:стартує|стартует|починається|начинается)\s+\d{1,2}\s+\p{L}+|starts?\s+(?:on\s+)?\d{1,2})/iu,
    /(?:реєстрац\p{L}*|регистрац\p{L}*|register\b|квитк\p{L}*|билет\p{L}*|tickets?\b|участь\s+у\s+(?:воркшоп|вебінар))/iu,
    /(?:проводить|проводит|спікер\p{L}*|спикер\p{L}*|speaker\b|hosted\s+by)[^.]{0,160}(?:recruit|рекрут|team\s+lead|hr\b)/iu,
  ].filter((pattern) => pattern.test(value)).length
  return signals >= 2
}

function isVisible(profile: StoredProfile): boolean {
  if (profile.origin === 'web') return true
  const text = `${profile.name || ''}\n${profile.role || ''}\n${profile.originalText || profile.description || ''}`
  if (isRecruitingOpportunity(text) || isCandidateEventPromotion(text) || isCharityAppeal(text)) return false
  return isLikelyCvPost(text, true)
}

function candidateAiInput(profile: CvProfile) {
  const normalized = repaired(profile)
  const rawText = normalized.originalText || normalized.description || ''
  const knownFacts: Record<string, unknown> = {
    name: normalized.name || null,
    age: normalized.age ?? null,
    isAdult: normalized.age == null ? null : normalized.isAdult ?? null,
    contacts: normalized.contacts || {},
  }
  return {
    rawText,
    knownFacts,
    fingerprint: aiFingerprint('candidate', rawText, {
      parserVersion: AI_CANDIDATE_PARSER_VERSION,
      ...knownFacts,
    }),
  }
}

function uniqueStrings(...lists: Array<string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((items) => items || []).map((item) => item.trim()).filter(Boolean))]
}

function hasAiField(data: CandidateAiData, field: keyof CandidateAiData): boolean {
  return Object.prototype.hasOwnProperty.call(data, field)
}

function mergeCandidateAi(profile: CvProfile, data: CandidateAiData): CvProfile {
  const merged: CvProfile = { ...profile }

  if (!merged.name && data.name?.trim()) merged.name = data.name.trim()

  if (data.professions?.length) {
    merged.professions = uniqueStrings(data.professions)
    merged.role = merged.professions[0] || merged.role
  } else {
    merged.professions = uniqueStrings(merged.professions)
  }
  if (Array.isArray(data.previousProfessions)) merged.previousProfessions = uniqueStrings(data.previousProfessions)

  merged.skills = uniqueStrings(merged.skills, data.skills)
  merged.features = uniqueStrings(merged.features, data.features)
  merged.languages = uniqueStrings(merged.languages, data.languages)

  if (Array.isArray(data.employmentTypes)) merged.employmentTypes = [...new Set(data.employmentTypes)]

  if (merged.age == null && data.age != null) merged.age = data.age
  merged.isAdult = merged.age == null ? true : merged.age >= 18

  if (hasAiField(data, 'experienceYears')) merged.experienceYears = data.experienceYears ?? null
  if (hasAiField(data, 'salaryMin')) merged.salaryMin = data.salaryMin ?? null
  if (hasAiField(data, 'salaryMax')) merged.salaryMax = data.salaryMax ?? null
  if (hasAiField(data, 'currency')) merged.currency = data.currency?.trim().toUpperCase() || null

  if (data.country?.trim()) merged.country = data.country.trim()
  if (hasAiField(data, 'city')) merged.city = data.city?.trim() || null
  if (hasAiField(data, 'district')) merged.district = data.district?.trim() || null
  if (hasAiField(data, 'remote')) merged.remote = data.remote ?? null
  if (hasAiField(data, 'relocationReady')) merged.relocationReady = data.relocationReady ?? null

  const education = data.education?.trim() || ''
  if (education && !mentionsEmploymentOrSchedule(education)) {
    merged.education = education
  }

  const contacts = { ...(merged.contacts || {}) }
  if (!contacts.telegram && data.contacts?.telegram) contacts.telegram = data.contacts.telegram
  if (!contacts.email && data.contacts?.email) contacts.email = data.contacts.email
  if (!contacts.phone && data.contacts?.phone) contacts.phone = data.contacts.phone
  merged.contacts = contacts
  merged.contact = merged.contact || contacts.telegram || contacts.email || contacts.phone || null

  return repaired(merged)
}

function derive(profile: StoredProfile): StoredProfile {
  if (profile.derived === DERIVED_VERSION) return profile
  const full = withProfessionExperience(repaired(profile)) as StoredProfile
  return {
    ...full,
    lastSeen: profile.lastSeen,
    ai: profile.ai,
    derived: DERIVED_VERSION,
    visible: isVisible(profile),
  }
}

async function persistStore(input: StoredProfile[]) {
  const list = input.map(derive)
  memoryStore = list
  try {
    await useStateStore().set(STORE_KEY, JSON.stringify(list), 'EX', STORE_TTL_SECONDS)
  } catch (error) {
    console.error('[hiring] failed to persist store:', (error as Error).message)
  }
}

async function loadStored(): Promise<StoredProfile[]> {
  try {
    const raw = await useStateStore().get(STORE_KEY)
    if (raw) return JSON.parse(raw) as StoredProfile[]
  } catch {
    // Fall through to memory/Postgres.
  }
  if (memoryStore.length) return memoryStore
  return hydrateFromDb()
}

function pruneStore(byKey: Map<string, StoredProfile>, now: number): StoredProfile[] {
  const nowDate = new Date(now)
  const oldestPosted = new Date(nowDate)
  oldestPosted.setUTCMonth(oldestPosted.getUTCMonth() - MAX_AGE_MONTHS)
  const kept: StoredProfile[] = []

  for (const rawProfile of byKey.values()) {
    if (!isVisible(rawProfile)) continue
    const profile = repaired(rawProfile)
    const posted = profile.createdAt ? new Date(profile.createdAt).getTime() : Number.NaN
    if (Number.isNaN(posted) || posted < oldestPosted.getTime() || posted > now + 48 * 60 * 60 * 1000) continue
    kept.push({ ...profile, lastSeen: rawProfile.lastSeen, ai: rawProfile.ai })
  }
  return kept
}

async function applyCandidateAiResult(
  key: string,
  fingerprint: string,
  result: AiExtractionResult<CandidateAiData>,
) {
  await withHiringStoreLock(async () => {
    const stored = await loadStored()
    const index = stored.findIndex((profile) => dedupKey(profile) === key)
    if (index < 0) return
    const current = stored[index]!
    if (candidateAiInput(current).fingerprint !== fingerprint) return

    const accepted = !result.lowConfidence && result.confidence >= AI_MIN_CONFIDENCE
    stored[index] = {
      ...(accepted ? mergeCandidateAi(current, result.data) : repaired(current)),
      lastSeen: current.lastSeen,
      ai: {
        fingerprint,
        status: accepted ? 'completed' : 'low_confidence',
        confidence: result.confidence,
        data: accepted ? result.data : undefined,
        updatedAt: new Date().toISOString(),
      },
    }
    await persistStore(stored)
  })
}

function scheduleCandidateAi(list: StoredProfile[]) {
  if (!aiWorkerEnabled()) return
  const batchSize = Math.max(1, Number(process.env.AI_WORKER_CANDIDATE_BATCH) || 24)
  let scheduled = 0
  const newestFirst = [...list].sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))

  for (const profile of newestFirst) {
    if (scheduled >= batchSize) break
    if (!isVisible(profile)) continue
    const input = candidateAiInput(profile)
    if (!input.rawText.trim()) continue

    if (profile.ai?.fingerprint === input.fingerprint) {
      const ageMs = Date.now() - Date.parse(profile.ai.updatedAt || '')
      if (profile.ai.status === 'completed' || profile.ai.status === 'low_confidence') continue
      if (profile.ai.status === 'pending' && Number.isFinite(ageMs) && ageMs < AI_PENDING_STALE_MS) continue
      if (profile.ai.status === 'failed' && Number.isFinite(ageMs) && ageMs < AI_FAILED_RETRY_MS) continue
    }

    const key = dedupKey(profile)
    const queued = scheduleAiExtraction<CandidateAiData>({
      id: key,
      kind: 'candidate',
      ...input,
      meta: { source: profile.source, sourceCountry: profile.country, id: profile.id, url: profile.url },
      onResult: (result) => applyCandidateAiResult(key, input.fingerprint, result),
      onFailed: async (status) => {
        if (status !== 'failed') return
        await withHiringStoreLock(async () => {
          const stored = await loadStored()
          const current = stored.find((item) => dedupKey(item) === key)
          if (!current || candidateAiInput(current).fingerprint !== input.fingerprint) return
          current.ai = { fingerprint: input.fingerprint, status: 'failed', updatedAt: new Date().toISOString() }
          await persistStore(stored)
        })
      },
    })

    if (queued) {
      profile.ai = { fingerprint: input.fingerprint, status: 'pending', updatedAt: new Date().toISOString() }
      scheduled += 1
    }
  }

  if (scheduled) console.log(`[hiring:ai] queued ${scheduled} candidate profiles`)
}

/** Merge one Telegram crawl result into the durable candidate snapshot. */
export async function persistTelegramCandidates(
  profiles: CvProfile[],
  diagnostic: SourceRun,
): Promise<number> {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const kept = await withHiringStoreLock(async () => {
    const byKey = new Map<string, StoredProfile>()
    for (const profile of await loadStored()) byKey.set(dedupKey(profile), profile)

    for (const rawProfile of profiles) {
      const profile = repaired(rawProfile)
      const sourceText = profile.originalText || profile.description || ''
      if (isRecruitingOpportunity(sourceText) || isCandidateEventPromotion(sourceText)) continue
      const key = dedupKey(profile)
      const previous = byKey.get(key)
      const input = candidateAiInput(profile)
      const reusableAi = previous?.ai?.fingerprint === input.fingerprint ? previous.ai : undefined
      const withAi = reusableAi?.status === 'completed' && reusableAi.data
        ? mergeCandidateAi(profile, reusableAi.data)
        : profile
      byKey.set(key, { ...withAi, lastSeen: nowIso, ai: reusableAi })
    }

    const next = pruneStore(byKey, now)
    await persistStore(next)
    return next
  })

  scheduleCandidateAi(kept)

  if (hiringDbEnabled()) {
    await saveDbCandidates(
      kept.filter((profile) => channelHandle(profile) === diagnostic.handle.toLowerCase()),
      diagnostic,
    )
  }

  return kept.length
}
