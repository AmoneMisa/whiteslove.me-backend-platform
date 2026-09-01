import { crawlStandardJobBoard } from './cyclicJobBoardCrawler'
import type { Job } from '~~/shared/contracts/jobs'

const API = 'https://career.intellias.com/wp-json/wp/v2/vacancy'

interface IntelliasVacancy {
  id?: number
  status?: string
  link?: string
  title?: { rendered?: string }
  remote_type?: string
  class_list?: string[]
  'status-vacancy'?: number[]
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function words(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() || ''}${part.slice(1)}`)
    .join(' ')
}

function taxonomyValues(item: IntelliasVacancy, prefix: string): string[] {
  return (item.class_list || [])
    .filter((value) => value.startsWith(prefix))
    .map((value) => words(value.slice(prefix.length)))
    .filter(Boolean)
}

function isOpen(item: IntelliasVacancy): boolean {
  if (item.status !== 'publish') return false
  const classes = item.class_list || []
  // Intellias marks currently displayed jobs with this taxonomy term. Keep the
  // numeric id as a fallback because the public WP API currently exposes both.
  return classes.includes('status-vacancy-in-progress')
    || (item['status-vacancy'] || []).includes(585)
}

function toJob(item: IntelliasVacancy): Job | null {
  if (!item.id || !item.link || !item.title?.rendered || !isOpen(item)) return null

  const title = decodeHtml(item.title.rendered)
  if (!title) return null

  const locations = taxonomyValues(item, 'location-')
  const families = taxonomyValues(item, 'job-family-')
  const profiles = taxonomyValues(item, 'job-profile-')
  const technologies = taxonomyValues(item, 'technology-')
  const levels = taxonomyValues(item, 'vacancy-level-')
  const workMode = String(item.remote_type || '').trim()

  return {
    id: `companies-intellias-${item.id}`,
    title,
    company: 'Intellias',
    location: locations.join(', ') || 'See listing',
    url: item.link,
    source: 'companies',
    remote: /^remote$/i.test(workMode),
    tags: [...new Set(['Intellias', ...families, ...profiles, ...technologies, ...levels, workMode].filter(Boolean))].slice(0, 8),
    // The WordPress post date is not the vacancy's closing state. Presence in
    // the in-progress collection is the authoritative "still open" signal, so
    // use last-seen time just like the generic career-page adapters do.
    postedAt: new Date().toISOString(),
    employmentType: workMode || undefined,
    employerType: 'direct',
  }
}

async function fetchPage(page: number): Promise<string> {
  const params = new URLSearchParams({
    // per_page is an upstream WordPress API shape, not a local crawl cap.
    per_page: '100',
    page: String(page),
    status: 'publish',
    orderby: 'modified',
    order: 'desc',
  })
  const response = await fetch(`${API}?${params}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)',
    },
  })
  // WordPress returns 400 when a historical page is past the end. Present it
  // to the shared crawler as an empty page so it can close and rotate the cycle.
  if (response.status === 400 && page > 1) return '[]'
  if (!response.ok) throw new Error(`career.intellias.com -> ${response.status}`)
  return response.text()
}

function parsePage(raw: string): Job[] {
  let items: IntelliasVacancy[]
  try {
    const parsed = JSON.parse(raw) as unknown
    items = Array.isArray(parsed) ? parsed as IntelliasVacancy[] : []
  } catch {
    return []
  }
  return items.flatMap((item) => {
    const job = toJob(item)
    return job ? [job] : []
  })
}

export async function fetchIntelliasJobs(q: string): Promise<Job[]> {
  if (process.env.INTELLIAS_SOURCE === 'off') return []

  const run = await crawlStandardJobBoard({
    key: 'intellias',
    fetchPage,
    parsePage: (raw) => parsePage(raw),
  })

  if (!q.trim()) return run.jobs
  const needle = q.toLocaleLowerCase('en')
  return run.jobs.filter((job) =>
    `${job.title} ${job.company} ${job.location} ${(job.tags || []).join(' ')}`
      .toLocaleLowerCase('en')
      .includes(needle),
  )
}
