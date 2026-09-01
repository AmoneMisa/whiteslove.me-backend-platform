import {
  detectUsLocation,
  detectVisaSponsorshipWording,
} from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import type { Job, JobSource } from './jobTypes'
import { HIRING_FACEBOOK_GROUPS } from '../../shared/hiring/sources/facebookGroups'
import {
  REMOTE_JOB_QUERIES,
  USA_RELOCATION_QUERIES,
  threadsJobCoverage,
} from './jobSearchCoverage'
import {
  classifySharedHiringMessage,
  detectHiringIntent,
  detectWorkModes,
  parseSharedHiringContext,
} from './hiringLexicon'

type Platform = 'facebook' | 'threads'

type Target = {
  key: string
  platform: Platform
  country: string
  city?: string
  region?: string
  target?: string
  query?: string
}

type SocialItem = {
  id?: string
  author?: string
  text?: string
  url?: string
  createdAt?: string | null
}

type SocialResponse = {
  ok?: boolean
  items?: SocialItem[]
  error?: string
}

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const FACEBOOK_TARGETS: Target[] = HIRING_FACEBOOK_GROUPS.map((group) => ({
  ...group,
  key: group.key.replace(/^facebook-/, 'fb-'),
  platform: 'facebook' as const,
}))

function threadsTargets(): Target[] {
  const remote = REMOTE_JOB_QUERIES.map((query, index) => ({
    key: `threads-remote-${index}`,
    platform: 'threads' as const,
    country: 'REMOTE',
    query,
  }))
  const usa = USA_RELOCATION_QUERIES.map((query, index) => ({
    key: `threads-usa-relocation-${index}`,
    platform: 'threads' as const,
    country: 'US',
    query,
  }))
  const regional = threadsJobCoverage().map((target) => ({
    key: target.key,
    platform: 'threads' as const,
    country: target.country,
    city: target.city,
    region: target.region,
    query: target.query,
  }))
  return [...remote, ...usa, ...regional]
}

function allTargets(): Target[] {
  return [...FACEBOOK_TARGETS, ...threadsTargets()]
}

function validDate(value: string | null | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  if (Date.now() - time > MAX_AGE_MS || time > Date.now() + 24 * 60 * 60 * 1000) return null
  return new Date(time).toISOString()
}

function isVacancyText(text: string): boolean {
  const kind = classifySharedHiringMessage(text)
  if (kind === 'candidate') return false
  if (kind === 'vacancy') return true
  return detectHiringIntent(text).intent === 'employer'
}

function titleFrom(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const vacancyLine = lines.find((line) => isVacancyText(line)) || lines[0] || 'Vacancy'
  return vacancyLine.replace(/https?:\/\/\S+/giu, '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Vacancy'
}

function sharedContext(text: string, title: string) {
  return parseSharedHiringContext(text, { mode: 'vacancy', title }) as {
    relocation?: 'offered' | 'required' | 'notOffered' | null
    workAuthorization?: string[]
  }
}

function toJob(item: SocialItem, target: Target): Job | null {
  const text = String(item.text || '').trim()
  const postedAt = validDate(item.createdAt)
  const url = String(item.url || '').trim()
  if (!text || !url || !postedAt || !isVacancyText(text)) return null

  const title = titleFrom(text)
  const context = sharedContext(text, title)
  const idPart = String(item.id || url).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(-140)
  const source = target.platform as JobSource
  const company = String(item.author || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    || (target.platform === 'facebook' ? 'Facebook' : 'Threads')
  const location = target.city
    ? `${target.city}, ${target.country}`
    : target.region
      ? `${target.region}, ${target.country}`
      : target.country === 'REMOTE'
        ? 'Remote / Worldwide'
        : target.country === 'US'
          ? 'United States / Relocation'
          : target.country

  const tags = [target.platform === 'facebook' ? 'Facebook' : 'Threads', target.country, target.key]
  const authorization = context.workAuthorization || []
  if (authorization.includes('sponsorshipOffered') || detectVisaSponsorshipWording(text) === 'offered') {
    tags.push('Visa sponsorship')
  }
  const relocation = context.relocation === 'offered' || context.relocation === 'required'
  if (relocation) tags.push('Relocation')
  if (relocation && (target.country === 'US' || detectUsLocation(`${text} ${target.query || ''}`))) {
    tags.push('USA relocation')
  }
  if (target.country === 'REMOTE' || /worldwide|anywhere|global\s+remote/iu.test(`${text} ${target.query || ''}`)) {
    tags.push('Worldwide remote')
  }

  return {
    id: `${target.platform}-${target.key}-${idPart}`,
    title,
    company,
    location,
    url,
    source,
    remote: target.country === 'REMOTE' || detectWorkModes(text).includes('remote'),
    tags,
    postedAt,
    description: text.slice(0, 6_000),
    country: /^[A-Z]{2}$/.test(target.country) ? target.country : undefined,
  }
}

async function fetchTarget(target: Target): Promise<Job[]> {
  const endpoint = String(process.env.HIRING_SOCIAL_API_URL || '').replace(/\/$/, '')
  const key = String(process.env.QUEUE_INTERNAL_KEY || '')
  if (!endpoint) throw new Error('HIRING_SOCIAL_API_URL is not configured')
  if (key.length < 16) throw new Error('QUEUE_INTERNAL_KEY is not configured')

  const payload = target.platform === 'facebook'
    ? { source: 'facebook', target: target.target }
    : { source: 'threads', mode: 'search', query: target.query }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-queue-key': key },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({})) as SocialResponse
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `${target.platform} social fetch -> HTTP ${response.status}`)
  }

  const items = Array.isArray(body.items) ? body.items : []
  const recent = items.filter((item) => Boolean(validDate(item.createdAt))).length
  const jobs = items.map((item) => toJob(item, target)).filter((job): job is Job => Boolean(job))
  console.log(`[jobs:${target.platform}] ${target.key}: fetched=${items.length} recent=${recent} classified=${jobs.length}`)
  return jobs
}

function targetName(target: Target): string {
  return `${SOCIAL_JOB_TARGET_PREFIX}${target.platform}:${target.key}`
}

export const SOCIAL_JOB_TARGET_PREFIX = 'social-job-source:'

export function configuredSocialJobTargets(): string[] {
  if (String(process.env.SOCIAL_JOB_SOURCE || 'on').toLowerCase() === 'off') return []
  return allTargets().map(targetName)
}

export function isSocialJobTarget(target: string): boolean {
  return target.startsWith(SOCIAL_JOB_TARGET_PREFIX)
}

function configForTarget(target: string): Target | undefined {
  if (!isSocialJobTarget(target)) return undefined
  return allTargets().find((candidate) => targetName(candidate) === target)
}

export function sourceForSocialJobTarget(target: string): 'facebook' | 'threads' | null {
  return configForTarget(target)?.platform || null
}

export async function fetchSocialJobTarget(target: string): Promise<Job[]> {
  const config = configForTarget(target)
  if (!config) throw new Error(`Unknown social job target ${target}`)
  return fetchTarget(config)
}
