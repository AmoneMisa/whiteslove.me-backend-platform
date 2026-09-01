export const SHARE_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://whiteslove.me').replace(/\/$/, '')
const FLAT_API_URL = process.env.FLAT_API_URL || 'http://185.5.206.229:8082'
const VALID_FLAT_SOURCES = new Set(['olx', 'telegram'])

// Social crawlers abandon a preview after only a few seconds (Telegram is the
// strictest), and flat lookups still cross a service boundary. Keep the budget
// well below the reverse-proxy timeout.
const SHARE_LOOKUP_TIMEOUT_MS = Number(process.env.SHARE_LOOKUP_TIMEOUT_MS) || 2500

// Crawlers fetch the same URL several times (and users re-share links), so cache
// resolved lookups briefly. Negative results are cached too, for less time.
const shareCache = new Map<string, { at: number; value: any }>()
const SHARE_CACHE_HIT_MS = 10 * 60_000
const SHARE_CACHE_MISS_MS = 30_000

function cacheGet(key: string): { value: any } | null {
  const hit = shareCache.get(key)
  if (!hit) return null
  const ttl = hit.value ? SHARE_CACHE_HIT_MS : SHARE_CACHE_MISS_MS
  if (Date.now() - hit.at > ttl) {
    shareCache.delete(key)
    return null
  }
  return { value: hit.value }
}

function cacheSet(key: string, value: any): any {
  if (shareCache.size > 500) shareCache.clear()
  shareCache.set(key, { at: Date.now(), value })
  return value
}

export type ShareMeta = {
  title: string
  description: string
  image: string
  imageType: 'image/png' | 'image/jpeg'
  url: string
  type: 'article' | 'website'
}

export function cleanShareText(value: unknown, max = 220): string {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function wrapShareText(value: unknown, maxChars = 34, maxLines = 3): string[] {
  const words = cleanShareText(value, 260).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxChars || !current) {
      current = next
      continue
    }
    lines.push(current)
    current = word
    if (lines.length >= maxLines - 1) break
  }

  if (current && lines.length < maxLines) lines.push(current)
  const consumed = lines.join(' ').length
  const original = words.join(' ')
  if (original.length > consumed && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
  }
  return lines
}

export async function findSharedJob(id: string): Promise<any | null> {
  const wanted = String(id || '').trim()
  if (!wanted) return null
  const cached = cacheGet(`job:${wanted}`)
  if (cached) return cached.value

  try {
    // Jobs API lives directly in Nuxt. Read the same persisted snapshot instead
    // of making a loopback HTTP call, but keep ingestion modules out of SSR.
    const { getStoredJobsSnapshot } = await import('../vacancies/infrastructure/jobsSnapshot')
    const jobs = await getStoredJobsSnapshot()
    const found = jobs.find((job) => job.id === wanted || job.url === wanted) || null
    return cacheSet(`job:${wanted}`, found)
  } catch {
    return null
  }
}

export async function findSharedCandidate(id: string): Promise<any | null> {
  const wanted = String(id || '').trim()
  if (!wanted) return null
  const cached = cacheGet(`candidate:${wanted}`)
  if (cached) return cached.value

  try {
    const [{ getStoredCvProfilesSnapshot }, { getStoredWebCvProfiles }] = await Promise.all([
      import('../hiring/application/readSnapshot'),
      import('../hiring/application/readWebProfiles'),
    ])
    const [stored, web] = await Promise.all([
      getStoredCvProfilesSnapshot(),
      getStoredWebCvProfiles(),
    ])
    const found = [...stored, ...web].find((profile) => profile.id === wanted || profile.url === wanted) || null
    return cacheSet(`candidate:${wanted}`, found)
  } catch {
    return null
  }
}

export async function findSharedFlat(id: string, source = '', country = ''): Promise<any | null> {
  const wanted = String(id || '').trim()
  if (!wanted) return null

  const params = new URLSearchParams({ listingId: wanted, limit: '1', offset: '0' })
  const normalizedSource = String(source || '').trim().toLowerCase()
  const normalizedCountry = String(country || '').trim().toUpperCase()
  if (VALID_FLAT_SOURCES.has(normalizedSource)) params.set('sources', normalizedSource)
  if (/^[A-Z]{2}$/.test(normalizedCountry)) params.set('countries', normalizedCountry)

  const key = `flat:${params}`
  const cached = cacheGet(key)
  if (cached) return cached.value

  try {
    const response = await fetch(`${FLAT_API_URL}/api/listings?${params}`, {
      signal: AbortSignal.timeout(SHARE_LOOKUP_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return cacheSet(key, null)
    const data = await response.json() as any
    const found = Array.isArray(data?.listings)
      ? data.listings.find((listing: any) => String(listing?.id) === wanted) || data.listings[0] || null
      : null
    // Don't cache a miss caused by a cold snapshot — the listing may well appear
    // once the country finishes warming.
    if (!found && data?.warming) return null
    return cacheSet(key, found)
  } catch {
    return null
  }
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function salaryLabel(job: any): string {
  const min = finiteNumber(job?.salaryMin)
  const max = finiteNumber(job?.salaryMax)
  if (min === null && max === null) return ''
  const currency = cleanShareText(job?.salaryCurrency || 'USD', 8)
  const period = job?.salaryPeriod ? `/${cleanShareText(job.salaryPeriod, 12)}` : ''
  const format = (value: number) => Math.round(value).toLocaleString('en-US')
  if (min !== null && max !== null) return `${format(min)}–${format(max)} ${currency}${period}`
  if (min !== null) return `from ${format(min)} ${currency}${period}`
  return `up to ${format(max!)} ${currency}${period}`
}

function flatPriceLabel(flat: any): string {
  const price = finiteNumber(flat?.price)
  if (price === null) return ''
  return `${Math.round(price).toLocaleString('en-US')} ${cleanShareText(flat?.currency || '', 8)}`.trim()
}

function candidateSalaryLabel(profile: any): string {
  const min = finiteNumber(profile?.salaryMin)
  const max = finiteNumber(profile?.salaryMax)
  if (min === null && max === null) return ''
  const currency = cleanShareText(profile?.currency || '', 8)
  const format = (value: number) => Math.round(value).toLocaleString('en-US')
  if (min !== null && max !== null) return `${format(min)}–${format(max)} ${currency}`.trim()
  if (min !== null) return `from ${format(min)} ${currency}`.trim()
  return `up to ${format(max!)} ${currency}`.trim()
}

function shareImageUrl(kind: 'job' | 'candidate' | 'flat', id: string, source = '', country = ''): string {
  const params = new URLSearchParams({ kind, id })
  if (source) params.set('source', source)
  if (country) params.set('country', country)
  return `${SHARE_SITE_URL}/share-og.png?${params}`
}

export function buildJobShareMeta(job: any, id: string, pathname = '/jobs'): ShareMeta {
  const title = cleanShareText([job?.title, job?.company].filter(Boolean).join(' — '), 120) || 'Vacancy · Job Finder'
  const details = [
    cleanShareText(job?.location, 80),
    job?.remote ? 'Remote' : '',
    salaryLabel(job),
    Array.isArray(job?.skills) ? job.skills.slice(0, 5).join(' · ') : '',
  ].filter(Boolean)
  const description = cleanShareText(details.join(' · ') || job?.description || 'Vacancy from Job Finder', 200)
  const encoded = encodeURIComponent(id)
  return {
    title,
    description,
    image: shareImageUrl('job', id),
    imageType: 'image/png',
    url: `${SHARE_SITE_URL}${pathname}?job=${encoded}`,
    type: 'article',
  }
}

export function buildCandidateShareMeta(
  profile: any,
  id: string,
  source = '',
  country = '',
  pathname = '/hiring',
): ShareMeta {
  const title = cleanShareText(
    [profile?.name, profile?.role].filter(Boolean).join(' — '),
    120,
  ) || 'Candidate · Hiring Board'
  const experienceYears = finiteNumber(profile?.experienceYears)
  const experience = experienceYears !== null
    ? `${experienceYears} years experience`
    : ''
  const details = [
    [profile?.city, profile?.country].filter(Boolean).join(', '),
    profile?.remote ? 'Remote' : '',
    experience,
    candidateSalaryLabel(profile),
    Array.isArray(profile?.skills) ? profile.skills.slice(0, 5).join(' · ') : '',
  ].filter(Boolean)
  const description = cleanShareText(
    details.join(' · ') || profile?.description || 'Candidate profile from Hiring Board',
    200,
  )
  const pageParams = new URLSearchParams({ cv: id })
  if (source) pageParams.set('cvSource', source)
  if (country) pageParams.set('cvCountry', country)

  return {
    title,
    description,
    image: shareImageUrl('candidate', id, source, country),
    imageType: 'image/png',
    url: `${SHARE_SITE_URL}${pathname}?${pageParams}`,
    type: 'article',
  }
}

export function buildFlatShareMeta(flat: any, id: string, source = '', country = '', pathname = '/flat-finder'): ShareMeta {
  const fallbackTitle = [
    finiteNumber(flat?.rooms) !== null ? `${flat.rooms}-room` : '',
    flat?.propertyType === 'house' ? 'house' : 'apartment',
    cleanShareText(flat?.city, 50),
  ].filter(Boolean).join(' · ')
  const title = cleanShareText(flat?.title, 120) || fallbackTitle || 'Property listing · Flat Finder'
  const floor = finiteNumber(flat?.floor) !== null
    ? finiteNumber(flat?.totalFloors) !== null ? `${flat.floor}/${flat.totalFloors} floor` : `${flat.floor} floor`
    : ''
  const description = cleanShareText([
    flatPriceLabel(flat),
    [flat?.city, flat?.district, flat?.area || flat?.kvartal].filter(Boolean).join(', '),
    finiteNumber(flat?.areaSqm) !== null ? `${flat.areaSqm} m²` : '',
    floor,
    flat?.petsAllowed === true ? 'Pet-friendly' : '',
  ].filter(Boolean).join(' · ') || flat?.description || 'Property listing from Flat Finder', 200)

  const pageParams = new URLSearchParams({ flat: id })
  if (source) pageParams.set('flatSource', source)
  if (country) pageParams.set('flatCountry', country)

  return {
    title,
    description,
    image: shareImageUrl('flat', id, source, country),
    imageType: 'image/png',
    url: `${SHARE_SITE_URL}${pathname}?${pageParams}`,
    type: 'website',
  }
}
