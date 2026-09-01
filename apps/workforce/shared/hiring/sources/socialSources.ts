import { HIRING_FACEBOOK_GROUPS } from './facebookGroups'

const SOCIAL_SOURCE_KEYS = [
  ...HIRING_FACEBOOK_GROUPS.map((group) => group.key),
  'threads-uz-ru',
  'threads-uz-ru-alt',
  'threads-uz-ru-parttime',
  'threads-uz-uz',
  'threads-uz-uz-short',
  'threads-uz-uz-izlayapman',
  'threads-uz-uz-qidiraman',
  'threads-uz-en-looking',
  'threads-uz-en-seeking',
  'threads-kz-almaty',
  'threads-kz-astana',
  'threads-kz-kazakh',
  'threads-kg-bishkek',
  'threads-kg-cv',
  'threads-kg-kyrgyz',
  'threads-ua-kyiv',
  'threads-ua-country',
  'threads-ro-bucharest',
  'threads-ro-job',
] as const

function selectedSourceKeys(envValue: string | undefined, available: readonly string[]): string[] {
  const selected = String(envValue || '').trim()
  if (!selected) return [...available]
  const allowed = new Set(selected.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
  return available.filter((key) => allowed.has(key.toLowerCase()))
}

/** Runtime-neutral source discovery for the Facebook/Threads candidate adapters. */
export function hiringSocialSourceHandles(): string[] {
  if (String(process.env.HIRING_SOCIAL_SOURCE || 'on').toLowerCase() === 'off') return []
  return selectedSourceKeys(process.env.HIRING_SOCIAL_SOURCES, SOCIAL_SOURCE_KEYS)
    .map((key) => `social:${key}`)
}

export function listHiringSocialSourceKeys(): string[] {
  return [...SOCIAL_SOURCE_KEYS]
}
