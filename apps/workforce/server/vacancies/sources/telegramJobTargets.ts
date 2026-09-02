import { extractJobStructuredField, parseHiringSourceSalary } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import type { Job } from '~~/shared/contracts/jobs'
import { detectWorkModes } from '../../utils/hiring/hiringLexicon'
import { isLikelyTelegramVacancy } from './telegramVacancyClassifier'

const UA = 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)'
const DESC_MAX = Number.POSITIVE_INFINITY

type TelegramChannel = {
  handle: string
  label: string
  location: string
  countryCode: string
  tags: string[]
  remoteByDefault?: boolean
  lowPriority?: boolean
}

const TELEGRAM_CHANNELS: TelegramChannel[] = [
  { handle: 'UzDev_Jobs', label: 'UzDev Jobs', location: 'Uzbekistan', countryCode: 'UZ', tags: ['IT'] },
  { handle: 'itcloz', label: 'IT Cloz', location: 'Uzbekistan', countryCode: 'UZ', tags: ['IT'] },
  { handle: 'clozjobs', label: 'CLOZ Jobs', location: 'Tashkent, Uzbekistan', countryCode: 'UZ', tags: ['Jobs', 'Local', 'Retail', 'Service'] },
  { handle: 'Ish_Toshkent', label: 'ISH TOSHKENT', location: 'Tashkent, Uzbekistan', countryCode: 'UZ', tags: ['Jobs', 'Local', 'EntryLevel', 'Retail'] },
  { handle: 'ish_bor_vakansiyalaruz', label: 'Ish Bor Vakansiyalar', location: 'Uzbekistan', countryCode: 'UZ', tags: ['General'] },
  { handle: 'ishbank', label: 'Ishbank', location: 'Uzbekistan', countryCode: 'UZ', tags: ['Banking', 'Finance'] },
  { handle: 'vacancyuzairports', label: 'Uzbekistan Airports Careers', location: 'Uzbekistan', countryCode: 'UZ', tags: ['Aviation'] },
  { handle: 'careerTBC', label: 'TBC Uzbekistan Careers', location: 'Uzbekistan', countryCode: 'UZ', tags: ['Banking', 'Fintech'] },
  { handle: 'tatu_karyera_markazi', label: 'TATU Career Center', location: 'Tashkent, Uzbekistan', countryCode: 'UZ', tags: ['IT', 'Junior'] },
  { handle: 'tdtu_karyera_markaz', label: 'TDTU Career Center', location: 'Tashkent, Uzbekistan', countryCode: 'UZ', tags: ['Engineering'] },
  { handle: 'linkedinjobsuzbekistan', label: 'LinkedIn Jobs Uzbekistan mirror', location: 'Uzbekistan', countryCode: 'UZ', tags: ['Mirror'], lowPriority: true },
  { handle: 'uzjobsuz', label: 'UzJobs mirror', location: 'Uzbekistan', countryCode: 'UZ', tags: ['Mirror'], lowPriority: true },
  { handle: 'android_jobs_for_future_tashkent', label: 'Android Jobs Tashkent', location: 'Tashkent, Uzbekistan', countryCode: 'UZ', tags: ['Android'], lowPriority: true },
  { handle: 'unilance', label: 'Unilance', location: 'Uzbekistan', countryCode: 'UZ', tags: ['IT', 'Jobs'] },
  { handle: 'jobmakon', label: 'Jobmakon', location: 'Uzbekistan', countryCode: 'UZ', tags: ['IT', 'Jobs', 'Internships'] },
  { handle: 'itjobstashkent', label: 'IT Jobs Tashkent', location: 'Tashkent, Uzbekistan', countryCode: 'UZ', tags: ['IT', 'Jobs'] },
  { handle: 'tashjobs', label: 'Tash Jobs', location: 'Tashkent, Uzbekistan', countryCode: 'UZ', tags: ['Jobs', 'Local', 'Retail', 'Service'] },
  { handle: 'ISHboor', label: 'IshBor', location: 'Tashkent, Uzbekistan', countryCode: 'UZ', tags: ['Jobs', 'Local', 'EntryLevel', 'Retail'] },
  { handle: 'tg_job', label: 'Работа в Узбекистане', location: 'Uzbekistan', countryCode: 'UZ', tags: ['Jobs', 'Local', 'Retail', 'Production'] },
  { handle: 'work_saleuz', label: 'Worksale.uz', location: 'Uzbekistan', countryCode: 'UZ', tags: ['Jobs', 'Local', 'Retail', 'Service'] },

  { handle: 'jobkz_1', label: 'JobKZ', location: 'Kazakhstan', countryCode: 'KZ', tags: ['General'] },
  { handle: 'devkz_jobs', label: 'DevKZ Jobs', location: 'Kazakhstan', countryCode: 'KZ', tags: ['IT'] },
  { handle: 'almaty_rabota_work', label: 'Almaty Rabota', location: 'Almaty, Kazakhstan', countryCode: 'KZ', tags: ['General'] },

  { handle: 'findwork', label: 'Find Work KG', location: 'Kyrgyzstan', countryCode: 'KG', tags: ['General'] },
  { handle: 'jobkg_official', label: 'Job KG', location: 'Kyrgyzstan', countryCode: 'KG', tags: ['General'] },
  { handle: 'jobslbish', label: 'Jobs Lbish', location: 'Kyrgyzstan', countryCode: 'KG', tags: ['General'] },
  { handle: 'jumush312kg', label: 'Jumush 312 KG', location: 'Bishkek, Kyrgyzstan', countryCode: 'KG', tags: ['General'] },

  { handle: 'robotaua_now_remote', label: 'robota.ua NOW Remote', location: 'Ukraine', countryCode: 'UA', tags: ['Remote', 'Jobs', 'Ukraine'], remoteByDefault: true },
  { handle: 'jobs_kyiv', label: 'Jobs Kyiv', location: 'Kyiv, Ukraine', countryCode: 'UA', tags: ['General'] },
  { handle: 'WORKIN_CHERNIVTSI', label: 'Work in Chernivtsi', location: 'Chernivtsi, Ukraine', countryCode: 'UA', tags: ['Jobs', 'General'] },
  { handle: 'happymonday', label: 'Happy Monday', location: 'Ukraine', countryCode: 'UA', tags: ['Jobs', 'Career', 'Ukraine'] },
  { handle: 'lobbyx', label: 'Lobby X', location: 'Ukraine', countryCode: 'UA', tags: ['Jobs', 'Ukraine'] },
  { handle: 'lobbyxIT', label: 'Lobby X IT', location: 'Ukraine', countryCode: 'UA', tags: ['IT', 'Jobs', 'Ukraine'] },
  { handle: 'univwork', label: 'UNI WORK', location: 'Ukraine', countryCode: 'UA', tags: ['Jobs', 'Internships', 'Junior', 'Ukraine'] },
  { handle: 'aplaywork', label: 'A-Play', location: 'Ukraine', countryCode: 'UA', tags: ['Jobs', 'Internships', 'Ukraine'] },
  { handle: 'ukrjob_one', label: 'UKRJOB', location: 'Ukraine', countryCode: 'UA', tags: ['Jobs', 'Remote', 'EntryLevel', 'Ecommerce'] },
  { handle: 'beejob1_ua', label: 'BEE JOB', location: 'Ukraine', countryCode: 'UA', tags: ['Jobs', 'Remote', 'EntryLevel', 'Ecommerce'] },
  { handle: 'workua_remote', label: 'Work.ua Remote', location: 'Ukraine', countryCode: 'UA', tags: ['Remote', 'Jobs', 'EntryLevel', 'Ukraine'], remoteByDefault: true },
  { handle: 'top_vacansii', label: 'CATWORK', location: 'Ukraine', countryCode: 'UA', tags: ['Remote', 'Jobs', 'Internships', 'Ukraine'], remoteByDefault: true },

  { handle: 'devjobro', label: 'DevJob Romania', location: 'Romania', countryCode: 'RO', tags: ['IT'] },
  { handle: 'jobs4ukrinromania', label: 'Jobs4UKR Romania', location: 'Romania', countryCode: 'RO', tags: ['Jobs', 'Local', 'EntryLevel', 'Romania'] },
  { handle: 'RoMunca', label: 'RoMunca', location: 'Romania', countryCode: 'RO', tags: ['Jobs', 'Local', 'Romania'] },
]

interface TelegramWorkerMessage {
  id: number
  text: string
  date: string | null
  preview?: string | null
  urls?: string[]
}

function channelKey(channel: TelegramChannel): string {
  return channel.handle.toLocaleLowerCase('en')
}

function configuredChannels(): TelegramChannel[] {
  if (process.env.TELEGRAM_SOURCE === 'off') return []
  const includeLowPriority = process.env.TELEGRAM_INCLUDE_LOW_PRIORITY === 'on'
  const byHandle = new Map<string, TelegramChannel>()
  for (const channel of TELEGRAM_CHANNELS) {
    if (channel.lowPriority && !includeLowPriority) continue
    const key = channelKey(channel)
    const existing = byHandle.get(key)
    if (!existing) {
      byHandle.set(key, channel)
      continue
    }
    byHandle.set(key, {
      ...existing,
      tags: [...new Set([...existing.tags, ...channel.tags])],
      remoteByDefault: existing.remoteByDefault || channel.remoteByDefault,
    })
  }
  return [...byHandle.values()]
}

function decodeTelegramEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', bull: '•',
  }
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x'
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function telegramText(html: string): string {
  return decodeTelegramEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function normalizeExternalUrl(raw: string): string | undefined {
  try {
    const url = new URL(decodeTelegramEntities(raw.trim()))
    if (!/^https?:$/.test(url.protocol)) return undefined
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 't.me' || host === 'telegram.me' || host === 'telegram.org') return undefined
    if (host === 'ya.cc' || host.endsWith('.ya.cc') || host === 'clck.yandex.ru') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function urlsFromText(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>()"']+/gi) || [])
    .map(normalizeExternalUrl)
    .filter((url): url is string => Boolean(url))
}

function urlsFromHtml(html: string): string[] {
  const urls: string[] = []
  for (const match of html.matchAll(/\bhref=["']([^"']+)["']/gi)) {
    const url = normalizeExternalUrl(match[1]!)
    if (url) urls.push(url)
  }
  return urls
}

function pickApplyUrl(text: string, supplied: string[] = []): string | undefined {
  const candidates = [...supplied, ...urlsFromText(text)]
    .map(normalizeExternalUrl)
    .filter((url): url is string => Boolean(url))
  const unique = [...new Set(candidates)]
  return unique.find((url) => /(?:linkedin\.com\/jobs|lnkd\.in|hh\.(?:uz|ru)\/vacancy|work\.ua|robota\.ua|jobs4ukr\.com|cloz\.uz|career|careers|jobs|vacanc|apply)/i.test(url))
    || unique[0]
}

function titleFromText(text: string, channel: TelegramChannel): string {
  const explicit = extractJobStructuredField(text, 'title', 180)
  if (explicit) return explicit.slice(0, 180)
  const line = text
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length >= 3 && value.length <= 180 && !/^#/.test(value))
  return line || `Vacancy from ${channel.label}`
}

function salaryFromText(text: string): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency'> {
  const line = text.split('\n').find((value) =>
    /💰|зарплат|заработн|оклад|оплата|\bsalary\b|maosh|маош|ish haqi|ойлик/i.test(value),
  ) || text
  const parsed = parseHiringSourceSalary(line)
  if (!parsed || (parsed.min == null && parsed.max == null) || !parsed.currency) return {}
  return {
    salaryMin: parsed.min ?? undefined,
    salaryMax: parsed.max ?? undefined,
    salaryCurrency: parsed.currency,
  }
}

function toJob(
  text: string,
  channel: TelegramChannel,
  id: string,
  url: string,
  date: string | null | undefined,
  externalUrls: string[] = [],
): Job | null {
  if (!isLikelyTelegramVacancy(text)) return null
  const title = titleFromText(text, channel)
  const company = extractJobStructuredField(text, 'company', 120) || channel.label
  const location = extractJobStructuredField(text, 'location', 120) || channel.location
  const hashtags = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,40})/gu)].map((match) => match[1]!)
  const applyUrl = pickApplyUrl(text, externalUrls)
  return {
    id,
    title,
    company,
    location,
    url,
    ...(applyUrl ? { applyUrl } : {}),
    source: 'telegram',
    remote: channel.remoteByDefault === true || detectWorkModes(`${title} ${text}`).includes('remote'),
    tags: [...channel.tags, channel.countryCode, `@${channel.handle}`, ...hashtags].slice(0, 8),
    postedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date().toISOString(),
    description: text.slice(0, DESC_MAX),
    ...salaryFromText(text),
  }
}

function parsePreview(html: string, channel: TelegramChannel): Job[] {
  const jobs: Job[] = []
  const chunks = html.split(/<div class="tgme_widget_message_wrap\b[^>]*>/i).slice(1)
  for (const chunk of chunks) {
    const post = chunk.match(/data-post="([^"]+)"/i)?.[1]
    const body = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]
    if (!post || !body) continue
    const datetime = chunk.match(/<time[^>]+datetime="([^"]+)"/i)?.[1]
    const job = toJob(
      telegramText(body),
      channel,
      `telegram-${post.replace(/[^a-z0-9_-]+/gi, '-')}`,
      `https://t.me/${post}`,
      datetime,
      urlsFromHtml(chunk),
    )
    if (job) jobs.push(job)
  }
  return jobs
}

async function fetchViaWorker(base: string, channel: TelegramChannel): Promise<Job[]> {
  const url = `${base.replace(/\/+$/, '')}/history?channel=${encodeURIComponent(channel.handle)}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`tg-worker @${channel.handle} -> ${response.status}`)
  const data = await response.json() as { ok?: boolean; messages?: TelegramWorkerMessage[] }
  if (!data.ok || !Array.isArray(data.messages)) throw new Error(`tg-worker @${channel.handle} bad payload`)
  return data.messages.flatMap((message) => {
    const text = [(message.text || '').trim(), (message.preview || '').trim()].filter(Boolean).join('\n')
    if (!text) return []
    const job = toJob(
      text,
      channel,
      `telegram-${channel.handle}-${message.id}`,
      `https://t.me/${channel.handle}/${message.id}`,
      message.date,
      message.urls || [],
    )
    return job ? [job] : []
  })
}

async function fetchViaPreview(channel: TelegramChannel): Promise<Job[]> {
  const response = await fetch(`https://t.me/s/${encodeURIComponent(channel.handle)}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!response.ok) throw new Error(`t.me/@${channel.handle} -> ${response.status}`)
  return parsePreview(await response.text(), channel)
}

async function fetchChannel(channel: TelegramChannel): Promise<Job[]> {
  const workerUrl = process.env.TELEGRAM_WORKER_URL
  return workerUrl ? fetchViaWorker(workerUrl, channel) : fetchViaPreview(channel)
}

export const TELEGRAM_JOB_TARGET_PREFIX = 'telegram-job-channel:'

export function configuredTelegramJobTargets(): string[] {
  return configuredChannels().map((channel) => `${TELEGRAM_JOB_TARGET_PREFIX}${channelKey(channel)}`)
}

export function isTelegramJobTarget(target: string): boolean {
  return target.startsWith(TELEGRAM_JOB_TARGET_PREFIX)
}

export async function fetchTelegramJobTarget(target: string): Promise<Job[]> {
  if (!isTelegramJobTarget(target)) throw new Error(`Unknown Telegram job target ${target}`)
  const key = target.slice(TELEGRAM_JOB_TARGET_PREFIX.length)
  const channel = configuredChannels().find((candidate) => channelKey(candidate) === key)
  if (!channel) throw new Error(`Unknown Telegram job target ${target}`)
  return fetchChannel(channel)
}
