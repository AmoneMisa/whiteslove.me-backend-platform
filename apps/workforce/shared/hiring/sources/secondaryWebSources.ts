export const SECONDARY_WEB_SOURCES = [
  { key: 'novarobota-ua', label: 'NovaRobota', country: 'UA' },
  { key: 'layboard-kz', label: 'Layboard', country: 'KZ' },
  { key: 'amountwork-ro', label: 'Amountwork', country: 'RO' },
] as const

export type SecondaryWebSource = (typeof SECONDARY_WEB_SOURCES)[number]
export type SecondaryWebSourceKey = SecondaryWebSource['key']

export const SECONDARY_WEB_SOURCE_KEYS = SECONDARY_WEB_SOURCES.map((source) => source.key)

export function enabledSecondaryWebSources(): SecondaryWebSource[] {
  if (process.env.HIRING_SECONDARY_WEB_CV_SOURCE === 'off') return []
  const raw = process.env.HIRING_SECONDARY_WEB_CV_SOURCES?.trim()
  if (!raw) return [...SECONDARY_WEB_SOURCES]
  const allowed = new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
  return SECONDARY_WEB_SOURCES.filter((source) => allowed.has(source.key))
}

/** Runtime-neutral discovery for the secondary web-CV adapters. */
export function hiringSecondaryWebSourceHandles(): string[] {
  return enabledSecondaryWebSources().map((source) => `web:${source.key}`)
}
