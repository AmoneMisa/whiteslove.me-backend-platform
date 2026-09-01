import { extractCandidateContacts } from '@whiteslove/parsing-lexicon/hiring-candidate-fields'
import { detectCandidateRemotePreference } from '@whiteslove/parsing-lexicon/hiring-semantics'
import { recordWebDiagnostic, type WebSourceDiagnostic } from '../../../shared/hiring/hiringDiagnostics'
import { SHARED_CANDIDATE_INTENT_RE, SHARED_EMPLOYER_INTENT_RE } from '../../utils/hiringLexicon'
import { normalizeCandidate } from '../../utils/hiringNormalize'
import type { CvProfile } from '~~/shared/contracts/hiring'
import { detectCity } from '../domain/telegramCandidateParser'
import { persistWebProfiles } from '../webProfilePersistence'
import {
  linkedinVoyagerConfigured,
  searchLinkedInPeopleReadOnly,
  type LinkedInVoyagerCandidate,
} from './linkedinVoyager'

const REQUEST_TIMEOUT_MS = 180_000
const DEFAULT_LIMIT = 24

type LinkedInCountry = 'UZ' | 'KZ' | 'KG' | 'UA' | 'RO'
type DirectContacts = NonNullable<CvProfile['contacts']>

type LinkedInTarget = {
  key: string
  label: string
  country: LinkedInCountry
  city?: string
  query: string
  scope?: 'profiles' | 'posts' | 'both'
  limit?: number
}

type LinkedInItem = {
  id?: string
  author?: string
  title?: string
  text?: string
  url?: string
  kind?: string
}

type LinkedInResponse = {
  ok?: boolean
  count?: number
  items?: LinkedInItem[]
  error?: string
}

const COUNTRY_NAMES: Record<LinkedInCountry, string> = {
  UZ: 'Uzbekistan',
  KZ: 'Kazakhstan',
  KG: 'Kyrgyzstan',
  UA: 'Ukraine',
  RO: 'Romania',
}

const TARGETS: LinkedInTarget[] = [
  { key: 'linkedin-uz-open-to-work', label: 'LinkedIn: Open to Work Uzbekistan', country: 'UZ', query: '"Open to Work" Uzbekistan', scope: 'both' },
  { key: 'linkedin-uz-tashkent-job-search', label: 'LinkedIn: ищу работу Ташкент', country: 'UZ', city: 'Tashkent', query: '"ищу работу" Ташкент', scope: 'both' },
  { key: 'linkedin-uz-tashkent-opportunities', label: 'LinkedIn: seeking opportunities Tashkent', country: 'UZ', city: 'Tashkent', query: '"seeking opportunities" Tashkent', scope: 'both' },
  { key: 'linkedin-uz-tashkent-open-to-work', label: 'LinkedIn: Open to Work Tashkent', country: 'UZ', city: 'Tashkent', query: '"Open to Work" Tashkent', scope: 'both' },
  { key: 'linkedin-uz-tashkent-looking-for-work', label: 'LinkedIn: looking for work Tashkent', country: 'UZ', city: 'Tashkent', query: '"looking for work" Tashkent', scope: 'both' },
  { key: 'linkedin-uz-tashkent-parttime', label: 'LinkedIn: ищу подработку Ташкент', country: 'UZ', city: 'Tashkent', query: '"ищу подработку" Ташкент', scope: 'both' },
  { key: 'linkedin-uz-tashkent-ish-qidiryapman', label: 'LinkedIn: ish qidiryapman Toshkent', country: 'UZ', city: 'Tashkent', query: '"ish qidiryapman" Toshkent', scope: 'both' },
  { key: 'linkedin-uz-tashkent-ish-kerak', label: 'LinkedIn: ish kerak Toshkent', country: 'UZ', city: 'Tashkent', query: '"ish kerak" Toshkent', scope: 'both' },
  { key: 'linkedin-kz-open-to-work', label: 'LinkedIn: Open to Work Kazakhstan', country: 'KZ', query: '"Open to Work" Kazakhstan', scope: 'both' },
  { key: 'linkedin-kz-almaty-job-search', label: 'LinkedIn: ищу работу Алматы', country: 'KZ', city: 'Almaty', query: '"ищу работу" Алматы', scope: 'both' },
  { key: 'linkedin-kg-open-to-work', label: 'LinkedIn: Open to Work Kyrgyzstan', country: 'KG', query: '"Open to Work" Kyrgyzstan', scope: 'both' },
  { key: 'linkedin-kg-bishkek-job-search', label: 'LinkedIn: ищу работу Бишкек', country: 'KG', city: 'Bishkek', query: '"ищу работу" Бишкек', scope: 'both' },
  { key: 'linkedin-ua-open-to-work', label: 'LinkedIn: Open to Work Ukraine', country: 'UA', query: '"Open to Work" Ukraine', scope: 'both' },
  { key: 'linkedin-ua-job-search', label: 'LinkedIn: шукаю роботу Україна', country: 'UA', query: '"шукаю роботу" Україна', scope: 'both' },
  { key: 'linkedin-ro-open-to-work', label: 'LinkedIn: Open to Work Romania', country: 'RO', query: '"Open to Work" Romania', scope: 'both' },
  { key: 'linkedin-ro-bucharest-job-search', label: 'LinkedIn: caut loc de muncă București', country: 'RO', city: 'Bucharest', query: '"caut loc de muncă" București', scope: 'both' },
]

function configuredTargets(): LinkedInTarget[] {
  if (String(process.env.HIRING_LINKEDIN_SOURCE || 'on').toLowerCase() === 'off') return []
  const selected = String(process.env.HIRING_LINKEDIN_SOURCES || '').trim()
  if (!selected) return TARGETS
  const allowed = new Set(selected.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
  return TARGETS.filter((target) => allowed.has(target.key.toLowerCase()))
}

export function hiringLinkedInSourceHandles(): string[] {
  return configuredTargets().map((target) => `linkedin:${target.key}`)
}

export function listHiringLinkedInSources(): Array<{ key: string; label: string; country: string; origin: 'linkedin' }> {
  return configuredTargets().map((target) => ({ key: target.key, label: target.label, country: target.country, origin: 'linkedin' }))
}

function contacts(text: string, country: LinkedInCountry): DirectContacts {
  return { ...extractCandidateContacts(text, country) }
}

function roleFrom(item: LinkedInItem): string {
  const title = String(item.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim()
  const parts = title.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean)
  if (parts.length >= 2) {
    const role = parts.slice(1).join(' - ')
    if (role.length >= 2 && role.length <= 180) return role
  }
  return ''
}

function itemToProfile(item: LinkedInItem, target: LinkedInTarget, checkedAt: string): CvProfile | null {
  const text = String(item.text || item.title || '').replace(/\s+/g, ' ').trim()
  const url = String(item.url || '').trim()
  if (!text || !url || !/^https?:\/\/(?:www\.)?linkedin\.com\/(?:in|posts)\//i.test(url)) return null
  if (!SHARED_CANDIDATE_INTENT_RE.test(text) || SHARED_EMPLOYER_INTENT_RE.test(text)) return null

  const publicContacts = contacts(text, target.country)
  const direct = publicContacts.telegram || publicContacts.email || publicContacts.phone || null
  const role = roleFrom(item)
  const author = String(item.author || '').trim()
  const id = String(item.id || url).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(-180)

  return normalizeCandidate({
    id: `linkedin-${target.key}-${id}`, source: 'social', origin: 'linkedin', sourceKey: target.key,
    sourceLabel: target.label, sourceCountry: target.country, country: target.country,
    name: author && author.length <= 100 ? author : '', role, professions: role ? [role] : [],
    city: detectCity(text, target.country) || target.city || null, isAdult: true,
    remote: detectCandidateRemotePreference(text),
    url, publishedAt: null, updatedAt: checkedAt, activityAt: checkedAt, createdAt: checkedAt,
    originalText: text.slice(0, 4_000), description: text.slice(0, 4_000), photos: [], photo: null,
    contacts: publicContacts, contact: direct || url, contactType: direct ? 'direct' : 'platform',
    tags: [target.label, 'LinkedIn', target.country, String(item.kind || 'public')],
  })
}

function voyagerText(candidate: LinkedInVoyagerCandidate): string {
  const experience = candidate.experiences
    .map((item) => [item.title, item.company, item.duration, item.location].filter(Boolean).join(' · '))
    .filter(Boolean)
  return [
    candidate.name,
    candidate.openToWork ? 'Open to Work' : '',
    candidate.headline,
    candidate.location ? `Location: ${candidate.location}` : '',
    candidate.company ? `Company: ${candidate.company}` : '',
    candidate.skills.length ? `Skills: ${candidate.skills.join(', ')}` : '',
    experience.length ? `Experience:\n${experience.join('\n')}` : '',
  ].filter(Boolean).join('\n')
}

export function voyagerCandidateToProfile(
  candidate: LinkedInVoyagerCandidate,
  target: LinkedInTarget,
  checkedAt: string,
): CvProfile | null {
  if (!candidate.id || !candidate.profileUrl || !candidate.name) return null
  const text = voyagerText(candidate)
  const currentRole = candidate.experiences[0]?.title || candidate.headline
  const previousRoles = candidate.experiences.slice(1).map((item) => item.title).filter((value): value is string => Boolean(value))
  return normalizeCandidate({
    id: `linkedin-${target.key}-${candidate.id}`,
    source: 'social',
    origin: 'linkedin',
    sourceKey: target.key,
    sourceLabel: target.label,
    sourceCountry: target.country,
    country: target.country,
    name: candidate.name.slice(0, 100),
    role: currentRole,
    professions: currentRole ? [currentRole] : [],
    previousProfessions: previousRoles,
    city: detectCity(candidate.location || text, target.country) || target.city || null,
    isAdult: true,
    remote: detectCandidateRemotePreference(text),
    url: candidate.profileUrl,
    publishedAt: null,
    updatedAt: checkedAt,
    activityAt: checkedAt,
    createdAt: checkedAt,
    originalText: text.slice(0, 8_000),
    description: text.slice(0, 8_000),
    skills: candidate.skills,
    education: candidate.school || null,
    photos: candidate.photo ? [candidate.photo] : [],
    photo: candidate.photo || null,
    contacts: {},
    contact: candidate.profileUrl,
    contactType: 'platform',
    tags: [
      target.label,
      'LinkedIn',
      target.country,
      'Voyager read-only',
      ...(candidate.openToWork ? ['Open to Work'] : []),
    ],
  })
}

async function fetchTargetViaVoyager(target: LinkedInTarget): Promise<{ profiles: CvProfile[]; fetched: number }> {
  const checkedAt = new Date().toISOString()
  const candidates = await searchLinkedInPeopleReadOnly({
    keywords: target.query,
    location: target.city || COUNTRY_NAMES[target.country],
    limit: target.limit || DEFAULT_LIMIT,
  })
  return {
    fetched: candidates.length,
    profiles: candidates
      .map((candidate) => voyagerCandidateToProfile(candidate, target, checkedAt))
      .filter((profile): profile is CvProfile => Boolean(profile)),
  }
}

async function fetchTargetViaWorker(target: LinkedInTarget): Promise<{ profiles: CvProfile[]; fetched: number }> {
  const endpoint = String(process.env.HIRING_SOCIAL_API_URL || '').replace(/\/$/, '')
  const internalKey = String(process.env.QUEUE_INTERNAL_KEY || '')
  if (!endpoint) throw new Error('HIRING_SOCIAL_API_URL is not configured')
  if (internalKey.length < 16) throw new Error('QUEUE_INTERNAL_KEY is not configured')

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-queue-key': internalKey },
    body: JSON.stringify({ source: 'linkedin', mode: 'candidates', query: target.query, scope: target.scope || 'both', limit: target.limit || DEFAULT_LIMIT }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = (await response.json().catch(() => ({}))) as LinkedInResponse
  if (!response.ok || body.ok === false) throw new Error(body.error || `LinkedIn candidate fetcher -> HTTP ${response.status}`)

  const checkedAt = new Date().toISOString()
  const items = Array.isArray(body.items) ? body.items : []
  return {
    fetched: Number.isFinite(body.count) ? Number(body.count) : items.length,
    profiles: items.map((item) => itemToProfile(item, target, checkedAt)).filter((item): item is CvProfile => Boolean(item)),
  }
}

async function fetchTarget(target: LinkedInTarget): Promise<{ profiles: CvProfile[]; fetched: number }> {
  if (linkedinVoyagerConfigured()) {
    try {
      const direct = await fetchTargetViaVoyager(target)
      if (direct.fetched || !process.env.HIRING_SOCIAL_API_URL) return direct
      console.warn(`[hiring:linkedin] ${target.key} Voyager returned no people; falling back to social worker`)
    } catch (error) {
      if (!process.env.HIRING_SOCIAL_API_URL) throw error
      console.warn(
        `[hiring:linkedin] ${target.key} Voyager failed; falling back to social worker:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return await fetchTargetViaWorker(target)
}

export async function refreshHiringLinkedInSource(handle: string): Promise<{ fetched: number; candidates: number; stored: number } | null> {
  if (String(process.env.HIRING_LINKEDIN_SOURCE || 'on').toLowerCase() === 'off') return null
  const key = handle.replace(/^linkedin:/i, '').toLowerCase()
  const target = configuredTargets().find((item) => item.key.toLowerCase() === key)
  if (!target) return null

  const startedAt = Date.now()
  const checkedAt = new Date().toISOString()
  const base = {
    handle: `linkedin:${target.key}`, key: `linkedin:${target.key}`, label: target.label, country: target.country,
    pages: 1, duplicate: 0, expired: 0, shown: 0, newestActivityAt: null, oldestActivityAt: null,
    lastSeenProfileId: '', lastSuccessAt: null, reachedCursor: false, checkedAt,
  }

  try {
    const run = await fetchTarget(target)
    const times = run.profiles.map((profile) => profile.activityAt || '').filter(Boolean).sort()
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
    console.log(`[hiring:linkedin] ${target.key} fetched=${run.fetched} candidates=${run.profiles.length} shown=${persisted.shown} store=${persisted.stored} in ${diagnostic.fetchDurationMs}ms`)
    return { fetched: run.fetched, candidates: run.profiles.length, stored: persisted.stored }
  } catch (error) {
    recordWebDiagnostic({
      ...base, status: 'error', fetched: 0, candidates: 0, blocks: 0, parsed: 0, rejected: 0,
      fetchDurationMs: Date.now() - startedAt, error: (error as Error).message,
    })
    throw error
  }
}
