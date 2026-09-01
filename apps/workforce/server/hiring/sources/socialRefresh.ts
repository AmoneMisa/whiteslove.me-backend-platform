import { extractCandidateContacts } from '@whiteslove/parsing-lexicon/hiring-candidate-fields'
import { detectCandidateRemotePreference } from '@whiteslove/parsing-lexicon/hiring-semantics'
import {
  fetchWithSourceExecutionPolicy,
  STANDARD_SOURCE_EXECUTION_POLICY,
} from '../../../packages/crawler-core/src/executionPolicy.ts'
import { HIRING_FACEBOOK_GROUPS } from '../../../shared/hiring/sources/facebookGroups'
import { recordWebDiagnostic, type WebSourceDiagnostic } from '../../utils/hiringDiagnostics'
import { normalizeCandidate, trimThreadsProfileText } from '../../utils/hiringNormalize'
import type { CvProfile } from '../../utils/hiringTypes'
import { detectCity, isLikelyCvPost } from '../domain/telegramCandidateParser'
import { persistWebProfiles } from '../webProfilePersistence'

const MAX_AGE_MONTHS = 3

type SocialPlatform = 'facebook' | 'threads'
type DirectContacts = NonNullable<CvProfile['contacts']>

type SocialTarget = {
  key: string
  label: string
  platform: SocialPlatform
  country: 'UZ' | 'KZ' | 'KG' | 'UA' | 'RO'
  city?: string
  target?: string
  query?: string
}

type SocialItem = {
  id?: string
  author?: string
  text?: string
  url?: string
  createdAt?: string | null
  images?: string[]
}

type SocialResponse = {
  ok?: boolean
  count?: number
  items?: SocialItem[]
  error?: string
}

const TARGETS: SocialTarget[] = [
  ...HIRING_FACEBOOK_GROUPS.map((group) => ({ ...group, platform: 'facebook' as const })),
  { key: 'threads-uz-ru', label: 'Threads: ищу работу Ташкент', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'ищу работу Ташкент' },
  { key: 'threads-uz-ru-alt', label: 'Threads: работу ищу Ташкент', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'работу ищу Ташкент' },
  { key: 'threads-uz-ru-parttime', label: 'Threads: ищу подработку Ташкент', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'ищу подработку Ташкент' },
  { key: 'threads-uz-uz', label: 'Threads: ish qidiryapman Toshkent', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'ish qidiryapman Toshkent' },
  { key: 'threads-uz-uz-short', label: 'Threads: ish kerak Toshkent', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'ish kerak Toshkent' },
  { key: 'threads-uz-uz-izlayapman', label: 'Threads: ish izlayapman Toshkent', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'ish izlayapman Toshkent' },
  { key: 'threads-uz-uz-qidiraman', label: 'Threads: ish qidiraman Toshkent', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'ish qidiraman Toshkent' },
  { key: 'threads-uz-en-looking', label: 'Threads: looking for work Tashkent', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'looking for work Tashkent' },
  { key: 'threads-uz-en-seeking', label: 'Threads: seeking opportunities Tashkent', platform: 'threads', country: 'UZ', city: 'Tashkent', query: 'seeking opportunities Tashkent' },
  { key: 'threads-kz-almaty', label: 'Threads: ищу работу Алматы', platform: 'threads', country: 'KZ', city: 'Almaty', query: 'ищу работу Алматы' },
  { key: 'threads-kz-astana', label: 'Threads: ищу работу Астана', platform: 'threads', country: 'KZ', city: 'Astana', query: 'ищу работу Астана' },
  { key: 'threads-kz-kazakh', label: 'Threads: жұмыс іздеймін Алматы', platform: 'threads', country: 'KZ', city: 'Almaty', query: 'жұмыс іздеймін Алматы' },
  { key: 'threads-kg-bishkek', label: 'Threads: ищу работу Бишкек', platform: 'threads', country: 'KG', city: 'Bishkek', query: 'ищу работу Бишкек' },
  { key: 'threads-kg-cv', label: 'Threads: резюме Бишкек', platform: 'threads', country: 'KG', city: 'Bishkek', query: 'резюме Бишкек' },
  { key: 'threads-kg-kyrgyz', label: 'Threads: жумуш издейм Бишкек', platform: 'threads', country: 'KG', city: 'Bishkek', query: 'жумуш издейм Бишкек' },
  { key: 'threads-ua-kyiv', label: 'Threads: шукаю роботу Київ', platform: 'threads', country: 'UA', city: 'Kyiv', query: 'шукаю роботу Київ' },
  { key: 'threads-ua-country', label: 'Threads: шукаю роботу Україна', platform: 'threads', country: 'UA', query: 'шукаю роботу Україна' },
  { key: 'threads-ro-bucharest', label: 'Threads: caut loc de muncă București', platform: 'threads', country: 'RO', city: 'Bucharest', query: 'caut loc de muncă București' },
  { key: 'threads-ro-job', label: 'Threads: îmi caut job București', platform: 'threads', country: 'RO', city: 'Bucharest', query: 'îmi caut job București' },
]

function configuredTargets(): SocialTarget[] {
  if (String(process.env.HIRING_SOCIAL_SOURCE || 'on').toLowerCase() === 'off') return []
  const selected = String(process.env.HIRING_SOCIAL_SOURCES || '').trim()
  if (!selected) return TARGETS
  const allowed = new Set(selected.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
  return TARGETS.filter((target) => allowed.has(target.key.toLowerCase()))
}

export function hiringSocialSourceHandles(): string[] {
  return configuredTargets().map((target) => `social:${target.key}`)
}

export function listSocialSources(): Array<{ key: string; label: string; country: string; origin: SocialPlatform }> {
  return configuredTargets().map((target) => ({ key: target.key, label: target.label, country: target.country, origin: target.platform }))
}

function cutoffTime(): number {
  const date = new Date()
  date.setUTCMonth(date.getUTCMonth() - MAX_AGE_MONTHS)
  return date.getTime()
}

function recentIso(value: string | null | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time < cutoffTime() || time > Date.now() + 48 * 60 * 60 * 1000) return null
  return new Date(time).toISOString()
}

function contacts(text: string, country: SocialTarget['country']): DirectContacts {
  return { ...extractCandidateContacts(text, country) }
}

const INTENT_PREFIX_RE = /(?:^|\n)\s*[^\p{L}\p{N}\n]{0,8}(?:я\s+)?(?:ищу|шукаю)\s+(?:себе\s+)?(?:работу|подработку|роботу|підробіток)\s*[:—-]?\s*/iu
const UZ_INTENT_PREFIX_RE = /(?:^|\n)\s*[^\p{L}\p{N}\n]{0,8}(?:menga\s+)?(?:ish(?:\s+joyi)?\s+kerak|ish\s+(?:qidiryapman|qidiraman|izlayapman))\s*[:—-]?\s*/iu
const LOCAL_CANDIDATE_INTENT_RE = /(?<![\p{L}\p{N}])(?:жұмыс\s+іздеймін|жумуш\s+(?:издейм|издеп\s+жатам)|иш\s+издейм|caut\s+(?:un\s+)?loc\s+de\s+munc[ăa]|(?:îmi|imi)\s+caut\s+(?:un\s+)?(?:job|loc\s+de\s+munc[ăa]))(?![\p{L}\p{N}])/iu

function roleFrom(text: string): string {
  const intent = text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).find((line) => /(?:ищу|шукаю).{0,20}(?:работ|робот)|(?:ish.{0,20}(?:kerak|qidir|izlay))|жұмыс\s+іздеймін|жумуш\s+(?:издейм|издеп)|caut\s+(?:un\s+)?loc\s+de\s+munc|(?:îmi|imi)\s+caut\s+(?:un\s+)?job/iu.test(line))
  const role = String(intent || '').replace(INTENT_PREFIX_RE, '').replace(UZ_INTENT_PREFIX_RE, '').replace(LOCAL_CANDIDATE_INTENT_RE, '').replace(/^\s*[:—-]\s*/, '').trim()
  return role.length >= 2 && role.length <= 180 ? role : ''
}

function nameFrom(item: SocialItem, text: string): string {
  const explicit = text.match(/(?:^|\n)\s*(?:имя|ім['’]я|ism(?:i|im)?|name|nume)\s*[:—-]\s*([^\n]{2,80})/iu)?.[1]?.trim()
  if (explicit && !/ваканс|компан|работ|робот|ish|job/iu.test(explicit)) return explicit
  const author = String(item.author || '').trim()
  return author && author.length <= 80 && !/^\d+$/.test(author) ? author : ''
}

function itemToProfile(item: SocialItem, target: SocialTarget): CvProfile | null {
  const rawText = String(item.text || '').trim()
  const text = target.platform === 'threads' ? trimThreadsProfileText(rawText, String(item.author || '')) : rawText
  const createdAt = recentIso(item.createdAt)
  const candidateIntent = isLikelyCvPost(text, true) || LOCAL_CANDIDATE_INTENT_RE.test(text)
  if (!createdAt || !item.url || !text || !candidateIntent) return null
  const publicContacts = contacts(text, target.country)
  const direct = publicContacts.telegram || publicContacts.email || publicContacts.phone || null
  const role = roleFrom(text)
  const id = String(item.id || item.url).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(-180)
  return normalizeCandidate({
    id: `social-${target.key}-${id}`, source: 'social', origin: target.platform, sourceKey: target.key,
    sourceLabel: target.label, sourceCountry: target.country, country: target.country,
    name: nameFrom(item, text), role, professions: role ? [role] : [],
    city: detectCity(text, target.country) || target.city || null, isAdult: true,
    remote: detectCandidateRemotePreference(text),
    url: item.url, publishedAt: createdAt, updatedAt: createdAt, activityAt: createdAt, createdAt,
    originalText: text.slice(0, 4_000), description: text.slice(0, 4_000),
    photos: Array.isArray(item.images) ? item.images.slice(0, 8) : [], photo: Array.isArray(item.images) ? item.images[0] || null : null,
    contacts: publicContacts, contact: direct || item.url, contactType: direct ? 'direct' : 'platform',
    tags: [target.label, target.platform === 'facebook' ? 'Facebook' : 'Threads', target.country],
  })
}

async function fetchTarget(target: SocialTarget): Promise<{ profiles: CvProfile[]; fetched: number }> {
  const endpoint = String(process.env.HIRING_SOCIAL_API_URL || '').replace(/\/$/, '')
  const key = String(process.env.QUEUE_INTERNAL_KEY || '')
  if (!endpoint) throw new Error('HIRING_SOCIAL_API_URL is not configured')
  if (key.length < 16) throw new Error('QUEUE_INTERNAL_KEY is not configured')

  const limit = STANDARD_SOURCE_EXECUTION_POLICY.maxItemsPerSource
  const payload = target.platform === 'facebook'
    ? { source: 'facebook', target: target.target, limit }
    : { source: 'threads', mode: 'search', query: target.query, limit }
  const response = await fetchWithSourceExecutionPolicy(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-queue-key': key },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({})) as SocialResponse
  if (!response.ok || body.ok === false) throw new Error(body.error || `social fetcher -> HTTP ${response.status}`)
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, limit)
  return {
    fetched: Math.min(Number.isFinite(body.count) ? Number(body.count) : items.length, limit),
    profiles: items.map((item) => itemToProfile(item, target)).filter((item): item is CvProfile => Boolean(item)),
  }
}

export async function refreshHiringSocialSource(handle: string): Promise<{ fetched: number; candidates: number; stored: number } | null> {
  if (String(process.env.HIRING_SOCIAL_SOURCE || 'on').toLowerCase() === 'off') return null
  const key = handle.replace(/^social:/i, '').toLowerCase()
  const target = configuredTargets().find((item) => item.key.toLowerCase() === key)
  if (!target) return null
  const startedAt = Date.now()
  const checkedAt = new Date().toISOString()
  const base = {
    handle: `social:${target.key}`, key: `social:${target.key}`, label: target.label, country: target.country,
    pages: 1, duplicate: 0, expired: 0, shown: 0, newestActivityAt: null, oldestActivityAt: null,
    lastSeenProfileId: '', lastSuccessAt: null, reachedCursor: false, checkedAt,
  }
  try {
    const run = await fetchTarget(target)
    const times = run.profiles.map((profile) => profile.createdAt || '').filter(Boolean).sort()
    const diagnostic: WebSourceDiagnostic = {
      ...base, status: run.profiles.length ? 'ok' : 'empty', fetched: run.fetched, candidates: run.profiles.length,
      blocks: run.fetched, parsed: run.profiles.length, rejected: Math.max(0, run.fetched - run.profiles.length),
      fetchDurationMs: Date.now() - startedAt, newestActivityAt: times.length ? times[times.length - 1]! : null,
      oldestActivityAt: times[0] || null, lastSuccessAt: checkedAt,
    }
    const persisted = await persistWebProfiles(run.profiles, diagnostic, target.key)
    diagnostic.shown = persisted.shown
    diagnostic.expired = persisted.expired
    recordWebDiagnostic(diagnostic)
    console.log(`[hiring:social] ${target.key} fetched=${run.fetched} candidates=${run.profiles.length} shown=${persisted.shown} store=${persisted.stored} in ${diagnostic.fetchDurationMs}ms`)
    return { fetched: run.fetched, candidates: run.profiles.length, stored: persisted.stored }
  } catch (error) {
    recordWebDiagnostic({
      ...base, status: 'error', fetched: 0, candidates: 0, blocks: 0, parsed: 0, rejected: 0,
      fetchDurationMs: Date.now() - startedAt, error: (error as Error).message,
    })
    throw error
  }
}
