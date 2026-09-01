// Candidate/resume transport for public Telegram channels.
// Parsing/classification lives in the hiring domain layer.

import type { CvProfile } from '../../../shared/contracts/hiring'
import { emptyCursor, loadCursors, saveCursor, type ChannelCursor } from '../../../shared/hiring/hiringCursors'
import {
  HIRING_TELEGRAM_CHANNELS,
  type HiringTelegramChannelDescriptor,
} from '../../../shared/hiring/sources/telegramChannels'
import {
  classifyTelegramMessage,
  telegramMessageToProfile,
  type TelegramCandidateChannel,
} from '../domain/telegramCandidateParser'
import {
  recordHiringSourceDiagnostic,
  type HiringSourceDiagnostic,
} from './telegramDiagnostics'

const UA = 'hiringFinder/1.0 (CV board; contact: admin@whiteslove.me)'
const TELEGRAM_PAGE_SIZE = Math.min(
  200,
  Math.max(50, Number(process.env.HIRING_TELEGRAM_PAGE_SIZE) || 150),
)
const TELEGRAM_WORKER_TIMEOUT_MS = 60_000

type TelegramChannel = TelegramCandidateChannel

export interface ChannelFunnel {
  fetched: number
  candidateMarkerMatched: number
  rejectedVacancy: number
  rejectedQuality: number
  candidates: number
}

function emptyFunnel(): ChannelFunnel {
  return { fetched: 0, candidateMarkerMatched: 0, rejectedVacancy: 0, rejectedQuality: 0, candidates: 0 }
}

interface TelegramFetchResult {
  profiles: CvProfile[]
  fetched: number
}

function telegramCountry(value: string): HiringTelegramChannelDescriptor['country'] {
  const normalized = value.trim().toUpperCase()
  if (normalized === 'UA' || normalized === 'KZ' || normalized === 'KG') return normalized
  return 'UZ'
}

function telegramChannels(): TelegramChannel[] {
  const raw = process.env.HIRING_TELEGRAM_CHANNELS
  if (!raw?.trim()) {
    return HIRING_TELEGRAM_CHANNELS.map((channel) => ({
      ...channel,
      tags: [...channel.tags],
      includeAny: channel.includeAny ? [...channel.includeAny] : undefined,
    }))
  }
  return raw.split(',').map((entry) => {
    const [handle = '', label = '', country = 'UZ'] = entry.split(':').map((part) => part.trim())
    const normalizedCountry = telegramCountry(country)
    return {
      handle,
      label: label || handle,
      country: normalizedCountry,
      location: label || country,
      tags: ['Resume'],
      cvFeed: true,
      requireCandidateMarker: normalizedCountry === 'UZ',
      historyLimit: normalizedCountry === 'UZ' ? 2_000 : 1_500,
    }
  }).filter((channel) => channel.handle)
}

function decodeTelegramEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x'
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function telegramText(html: string): string {
  return decodeTelegramEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').trim()
}

interface TelegramWorkerMessage { id: number; text: string; date: string | null; preview?: string | null }
interface TelegramWorkerHistory { ok?: boolean; messages?: TelegramWorkerMessage[] }

interface PageRequest {
  afterId?: number
  beforeId?: number
  limit: number
}

interface PageResult {
  profiles: CvProfile[]
  funnel: ChannelFunnel
  newestId: number
  oldestId: number
  more: boolean
  reachedCutoff: boolean
}

function emptyPage(): PageResult {
  return { profiles: [], funnel: emptyFunnel(), newestId: 0, oldestId: 0, more: false, reachedCutoff: false }
}

function candidateCutoff(): number {
  const cutoff = new Date()
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3)
  return cutoff.getTime()
}

async function fetchWorkerPage(
  base: string,
  channel: TelegramChannel,
  q: string,
  request: PageRequest,
): Promise<PageResult> {
  const needle = q.trim().toLocaleLowerCase('ru')
  const params = new URLSearchParams({ channel: channel.handle, limit: String(request.limit) })
  if (request.beforeId && request.beforeId > 0) params.set('beforeId', String(request.beforeId))

  const res = await fetch(`${base.replace(/\/+$/, '')}/history?${params}`, {
    signal: AbortSignal.timeout(TELEGRAM_WORKER_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`tg-worker @${channel.handle} -> ${res.status}`)
  const data = (await res.json()) as TelegramWorkerHistory
  if (!data.ok || !Array.isArray(data.messages)) throw new Error(`tg-worker @${channel.handle} bad payload`)

  const page = emptyPage()
  if (!data.messages.length) return page

  const cutoff = candidateCutoff()
  const ids: number[] = []
  let oldestDate = Number.POSITIVE_INFINITY

  for (const message of data.messages) {
    if (request.afterId && Number(message.id) <= request.afterId) {
      page.more = false
      break
    }
    if (Number.isFinite(message.id)) ids.push(Number(message.id))

    const text = [(message.text || '').trim(), (message.preview || '').trim()].filter(Boolean).join('\n')
    if (!text) continue
    page.funnel.fetched += 1

    if (message.date) {
      const stamp = Date.parse(message.date)
      if (Number.isFinite(stamp)) oldestDate = Math.min(oldestDate, stamp)
    }

    const outcome = classifyTelegramMessage(text, {
      id: `telegram-${channel.handle}-${message.id}`,
      url: `https://t.me/${channel.handle}/${message.id}`,
      dateIso: message.date,
    }, channel, needle)

    if (outcome.candidateMarker) page.funnel.candidateMarkerMatched += 1
    if (outcome.reason === 'vacancy') page.funnel.rejectedVacancy += 1
    else if (outcome.reason === 'quality') page.funnel.rejectedQuality += 1
    if (outcome.profile) {
      page.profiles.push(outcome.profile)
      page.funnel.candidates += 1
    }
  }

  if (ids.length) {
    page.newestId = Math.max(...ids)
    page.oldestId = Math.min(...ids)
  }
  page.reachedCutoff = Number.isFinite(oldestDate) && oldestDate < cutoff
  page.more = !page.reachedCutoff && data.messages.length >= request.limit
  return page
}

function parseChannelHtml(html: string, channel: TelegramChannel, q: string): TelegramFetchResult {
  const profiles: CvProfile[] = []
  const chunks = html.split(/<div class="tgme_widget_message_wrap\b[^>]*>/i).slice(1)
  const needle = q.trim().toLocaleLowerCase('ru')
  for (const chunk of chunks) {
    const postId = chunk.match(/data-post="([^"]+)"/i)?.[1]
    const body = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]
    if (!postId || !body) continue
    const datetime = chunk.match(/<time[^>]+datetime="([^"]+)"/i)?.[1]
    const profile = telegramMessageToProfile(telegramText(body), {
      id: `telegram-${postId.replace(/[^a-z0-9_-]+/gi, '-')}`,
      url: `https://t.me/${postId}`,
      dateIso: datetime,
    }, channel, needle)
    if (profile) profiles.push(profile)
  }
  return { profiles, fetched: chunks.length }
}

async function fetchTelegramChannel(channel: TelegramChannel, q: string): Promise<TelegramFetchResult> {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(channel.handle)}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`t.me/@${channel.handle} -> ${res.status}`)
  return parseChannelHtml(await res.text(), channel, q)
}

export interface ChannelOutcome {
  result: TelegramFetchResult
  diagnostic: HiringSourceDiagnostic
  cursor: ChannelCursor
}

async function crawlChannel(
  base: string,
  channel: TelegramChannel,
  q: string,
  cursor: ChannelCursor,
): Promise<{ profiles: CvProfile[]; funnel: ChannelFunnel; cursor: ChannelCursor; mode: 'incremental' | 'backfill' | 'idle' }> {
  const funnel = emptyFunnel()
  const profiles: CvProfile[] = []
  const next: ChannelCursor = { ...cursor }
  let mode: 'incremental' | 'backfill' | 'idle' = 'idle'

  const incremental = await fetchWorkerPage(base, channel, q, {
    afterId: cursor.newestMessageId || undefined,
    limit: TELEGRAM_PAGE_SIZE,
  })
  if (incremental.funnel.fetched > 0) mode = 'incremental'
  profiles.push(...incremental.profiles)
  addFunnel(funnel, incremental.funnel)
  if (incremental.newestId) next.newestMessageId = Math.max(next.newestMessageId, incremental.newestId)
  if (!next.oldestMessageId && incremental.oldestId) next.oldestMessageId = incremental.oldestId

  if (!next.bootstrapComplete && next.oldestMessageId) {
    const backfill = await fetchWorkerPage(base, channel, q, {
      beforeId: next.oldestMessageId,
      limit: TELEGRAM_PAGE_SIZE,
    })
    if (backfill.funnel.fetched > 0 && mode === 'idle') mode = 'backfill'
    profiles.push(...backfill.profiles)
    addFunnel(funnel, backfill.funnel)
    if (backfill.oldestId) next.oldestMessageId = Math.min(next.oldestMessageId, backfill.oldestId)
    if (backfill.reachedCutoff || !backfill.more || !backfill.oldestId) next.bootstrapComplete = true
  } else if (!next.oldestMessageId && !incremental.more) {
    next.bootstrapComplete = true
  }

  next.lastSuccessAt = new Date().toISOString()
  return { profiles, funnel, cursor: next, mode }
}

function addFunnel(total: ChannelFunnel, page: ChannelFunnel): void {
  total.fetched += page.fetched
  total.candidateMarkerMatched += page.candidateMarkerMatched
  total.rejectedVacancy += page.rejectedVacancy
  total.rejectedQuality += page.rejectedQuality
  total.candidates += page.candidates
}

async function readChannel(channel: TelegramChannel, q: string, cursor: ChannelCursor): Promise<ChannelOutcome> {
  const checkedAt = new Date().toISOString()
  const startedAt = Date.now()
  const workerUrl = process.env.TELEGRAM_WORKER_URL

  try {
    if (!workerUrl) {
      const result = await fetchTelegramChannel(channel, q)
      return {
        result,
        cursor,
        diagnostic: {
          handle: channel.handle,
          country: channel.country,
          status: result.profiles.length ? 'ok' : 'empty',
          fetched: result.fetched,
          candidateMarkerMatched: 0,
          rejectedVacancy: 0,
          rejectedQuality: Math.max(0, result.fetched - result.profiles.length),
          candidates: result.profiles.length,
          mode: 'incremental',
          newestMessageId: cursor.newestMessageId,
          oldestMessageId: cursor.oldestMessageId,
          bootstrapComplete: cursor.bootstrapComplete,
          fetchDurationMs: Date.now() - startedAt,
          checkedAt,
        },
      }
    }

    const round = await crawlChannel(workerUrl, channel, q, cursor)
    await saveCursor(round.cursor)
    return {
      result: { profiles: round.profiles, fetched: round.funnel.fetched },
      cursor: round.cursor,
      diagnostic: {
        handle: channel.handle,
        country: channel.country,
        status: round.profiles.length ? 'ok' : 'empty',
        fetched: round.funnel.fetched,
        candidateMarkerMatched: round.funnel.candidateMarkerMatched,
        rejectedVacancy: round.funnel.rejectedVacancy,
        rejectedQuality: round.funnel.rejectedQuality,
        candidates: round.funnel.candidates,
        mode: round.mode,
        newestMessageId: round.cursor.newestMessageId,
        oldestMessageId: round.cursor.oldestMessageId,
        bootstrapComplete: round.cursor.bootstrapComplete,
        fetchDurationMs: Date.now() - startedAt,
        checkedAt,
      },
    }
  } catch (err) {
    const error = (err as Error).message
    console.error(`[hiring] telegram @${channel.handle} failed:`, error)
    return {
      result: { profiles: [], fetched: 0 },
      cursor,
      diagnostic: {
        handle: channel.handle,
        country: channel.country,
        status: 'error',
        fetched: 0,
        candidateMarkerMatched: 0,
        rejectedVacancy: 0,
        rejectedQuality: 0,
        candidates: 0,
        mode: 'idle',
        newestMessageId: cursor.newestMessageId,
        oldestMessageId: cursor.oldestMessageId,
        bootstrapComplete: cursor.bootstrapComplete,
        fetchDurationMs: Date.now() - startedAt,
        checkedAt,
        error,
      },
    }
  }
}

/** Configured handles, in fetch order — the queue scheduler fans these out. */
export function hiringChannelHandles(): string[] {
  return telegramChannels()
    .filter((channel) => channel.enabled !== false)
    .map((channel) => channel.handle)
}

/** Refresh one configured Telegram channel for the per-channel queue task. */
export async function fetchHiringChannel(handle: string, q = ''): Promise<ChannelOutcome | null> {
  if (process.env.TELEGRAM_SOURCE === 'off') return null
  const wanted = handle.replace(/^@/, '').toLowerCase()
  const channel = telegramChannels().find(
    (item) => item.enabled !== false && item.handle.toLowerCase() === wanted,
  )
  if (!channel) return null

  const cursors = await loadCursors()
  const outcome = await readChannel(channel, q, cursors.get(channel.handle) || emptyCursor(channel.handle))
  recordHiringSourceDiagnostic(outcome.diagnostic)
  return outcome
}
