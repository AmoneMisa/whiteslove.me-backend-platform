const LINKEDIN_SOURCE_KEYS = [
  'linkedin-uz-open-to-work',
  'linkedin-uz-tashkent-job-search',
  'linkedin-uz-tashkent-opportunities',
  'linkedin-uz-tashkent-open-to-work',
  'linkedin-uz-tashkent-looking-for-work',
  'linkedin-uz-tashkent-parttime',
  'linkedin-uz-tashkent-ish-qidiryapman',
  'linkedin-uz-tashkent-ish-kerak',
  'linkedin-kz-open-to-work',
  'linkedin-kz-almaty-job-search',
  'linkedin-kg-open-to-work',
  'linkedin-kg-bishkek-job-search',
  'linkedin-ua-open-to-work',
  'linkedin-ua-job-search',
  'linkedin-ro-open-to-work',
  'linkedin-ro-bucharest-job-search',
] as const

function selectedSourceKeys(envValue: string | undefined, available: readonly string[]): string[] {
  const selected = String(envValue || '').trim()
  if (!selected) return [...available]
  const allowed = new Set(selected.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
  return available.filter((key) => allowed.has(key.toLowerCase()))
}

/** Runtime-neutral source discovery for LinkedIn candidate adapters. */
export function hiringLinkedInSourceHandles(): string[] {
  if (String(process.env.HIRING_LINKEDIN_SOURCE || 'on').toLowerCase() === 'off') return []
  return selectedSourceKeys(process.env.HIRING_LINKEDIN_SOURCES, LINKEDIN_SOURCE_KEYS)
    .map((key) => `linkedin:${key}`)
}

export function listHiringLinkedInSourceKeys(): string[] {
  return [...LINKEDIN_SOURCE_KEYS]
}
