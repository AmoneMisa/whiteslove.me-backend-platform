import { parseHiringVacancySalary } from '@whiteslove/parsing-lexicon/hiring-salary-context'
import { detectUsLocation } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import type { Job, SponsorshipConfidence } from '~~/shared/contracts/jobs'
import { detectWorkModes } from '../hiring/hiringLexicon'
import { absoluteHttpUrl as absoluteUrl, decodeHtmlEntities, stripHtml } from '../support/htmlText'

export type PublicBoard = {
  label: string
  url: string
  /** Country the listing belongs to when the board is national. */
  country?: string
  remoteByDefault?: boolean
  usOnly?: boolean
  assumeUs?: boolean
  sponsorshipConfidence?: SponsorshipConfidence
  sponsorshipEvidence?: string
}

export type FlagmaJobBoardDescriptor = Pick<PublicBoard, 'label' | 'url' | 'country'>

// Flagma parsing stays here as source-specific markup knowledge. Its execution
// is owned by the community-board queue target and the shared cyclic/detail
// crawler policy.
const FLAGMA_VACANCY_LINK_RE =
  /<a\b[^>]*href="([^"]*flagma\.[a-z]{2}\/(?:ru\/)?vakansiya-[^"?#]*-rv\d+\.html)"[^>]*>([\s\S]*?)<\/a>/gi

/** Card markup as rows, because each row of a Flagma card means something. */
function cardLines(fragment: string): string[] {
  return decodeHtmlEntities(fragment)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|span|td)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

export function parseFlagmaVacancies(html: string, board: FlagmaJobBoardDescriptor): Job[] {
  const jobs: Job[] = []
  const seen = new Set<string>()
  const matches = [...html.matchAll(FLAGMA_VACANCY_LINK_RE)]

  for (const [index, match] of matches.entries()) {
    const url = match[1]!
    if (seen.has(url)) continue
    seen.add(url)

    // The card runs to the next link for a *different* vacancy: a card holds
    // several anchors to the same posting, and stopping at the first of them
    // would cut off the employer and location rows that follow the title.
    const start = Math.max(0, (match.index ?? 0) - 200)
    const nextDistinct = matches.slice(index + 1).find((candidate) => candidate[1] !== url)
    const end = nextDistinct?.index ?? Math.min(html.length, (match.index ?? 0) + 2_000)
    // The shared stripHtml flattens a document to one line, which is right for
    // the generic boards and useless here: this card's meaning is in its rows.
    const lines = cardLines(html.slice(start, end))

    const title = stripHtml(match[2] || '') || lines[0] || ''
    // "Коваленко О.А., ФЛП" then "| Полтава, UA" — the employer and where it
    // is, which the card may put on one row or two.
    const employerRowIndex = lines.findIndex((line) => /\|\s*[^|]+,\s*[A-Z]{2}\s*$/.test(line))
    const employerRow = employerRowIndex >= 0 ? lines[employerRowIndex]! : ''
    const inlineEmployer = employerRow.includes('|') ? employerRow.split('|')[0]!.trim() : ''
    const employerPart = inlineEmployer
      || (employerRowIndex > 0 ? lines[employerRowIndex - 1]!.replace(/[|,]+$/, '').trim() : '')
    const locationPart = employerRow.replace(/^[^|]*\|/, '').trim()
    // "в Бухаресте, полная занятость" — where the work is.
    const placementLine = lines.find((line) => /^(?:в|у|in)\s+\p{Lu}/u.test(line)) || ''

    const text = lines.join(' ')
    const cleanTitle = title.replace(/\s+/g, ' ').trim()
    if (cleanTitle.length < 3 || cleanTitle.length > 180) continue

    jobs.push({
      id: `flagma-${url.match(/-rv(\d+)\.html/)?.[1] || url.slice(-24)}`,
      title: cleanTitle,
      company: employerPart || board.label,
      // "в Бухаресте, полная занятость" -> "Бухаресте". The city keeps the
      // grammatical case the site prints; declining it back is not worth a
      // dictionary, and the string is only ever displayed.
      location: placementLine
        .replace(/^(?:в|у|in)\s+/iu, '')
        .replace(/,\s*(?:полная|частичная|неполная)\s+занятость.*$/iu, '')
        .replace(/,\s*удал[ёе]нно.*$/iu, '')
        .trim()
        || locationPart
        || board.country
        || '',
      url,
      source: 'companies',
      remote: detectWorkModes(text).includes('remote'),
      postedAt: new Date().toISOString(),
      description: lines.slice(0, 8).join(' · ').slice(0, 600),
      tags: [board.label, ...(board.country ? [board.country] : [])],
    } as Job)
  }

  return jobs
}

// The pay sits in one visible row ("7 500 000 - 12 000 000 сум"), while the
// microdata beside it carries a single `value`. Reading that attribute alone
// collapsed every range onto its first number and left the period unknown, so
// the row goes to the shared vacancy salary parser, which owns ranges, periods
// and the country fallbacks (UZ quotes monthly pay, RO too).
const FLAGMA_SALARY_MICRODATA_RE = /<[^>]*\bitemprop=["'](?:value|minValue|maxValue|currency)["']/iu
const FLAGMA_BLOCK_BOUNDARY_RE = /<\/?(?:div|p|li|tr|td|table|h[1-6]|section|br)\b[^>]*>/i

function flagmaSalaryRow(html: string): string {
  const at = html.search(FLAGMA_SALARY_MICRODATA_RE)
  if (at < 0) return ''
  // Keep to the row the microdata sits in: the amount can be printed before the
  // marked-up span, the currency word after it, and neither crosses a block tag.
  const before = html.slice(Math.max(0, at - 400), at).split(FLAGMA_BLOCK_BOUNDARY_RE).pop() || ''
  const after = html.slice(at, at + 600).split(FLAGMA_BLOCK_BOUNDARY_RE)[0] || ''
  return stripHtml(`${before}${after}`).replace(/\s+/g, ' ').trim()
}

/** Board country: the listing says it, else the national domain does. */
function flagmaCountry(summary: Job, location: string): string | undefined {
  return location.match(/,\s*([A-Za-z]{2})\s*$/)?.[1]?.toUpperCase()
    || summary.country
    || summary.url.match(/flagma\.([a-z]{2})\b/i)?.[1]?.toUpperCase()
}

function flagmaSalary(
  html: string,
  summary: Job,
  location: string,
): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'> {
  const country = flagmaCountry(summary, location)
  const parsed = parseHiringVacancySalary(flagmaSalaryRow(html), {
    country,
    currencyFallback: 'country',
    periodFallback: 'country',
  })
  // The row is found by scanning the whole page for the *first* itemprop=value
  // node, which is also how schema.org marks up unrelated PropertyValue facts
  // (schedule, experience, etc.). A row that only reads as salary because
  // "Оплата труда"-style wording happened to sit in its 400/600-char window,
  // with no currency actually named next to the number, is that false match
  // (e.g. "9:00" from a work-hours line) rather than real pay — require the
  // currency to be explicit in the row itself, not a country-level guess.
  if (!parsed || (parsed.min == null && parsed.max == null) || parsed.currencySource !== 'explicit') {
    return {
      salaryMin: summary.salaryMin,
      salaryMax: summary.salaryMax,
      salaryCurrency: summary.salaryCurrency,
      salaryPeriod: summary.salaryPeriod,
    }
  }
  return {
    salaryMin: parsed.min ?? parsed.max ?? undefined,
    salaryMax: parsed.max ?? parsed.min ?? undefined,
    salaryCurrency: parsed.currency?.toUpperCase() || summary.salaryCurrency,
    salaryPeriod: (parsed.period as Job['salaryPeriod']) || summary.salaryPeriod,
  }
}

export function parseFlagmaVacancyDetail(html: string, summary: Job): Job | null {
  const canonical = absoluteUrl(
    html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/iu)?.[1] || summary.url,
    summary.url,
  )
  const heading = stripHtml(
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] || '',
  )
  const title = stripHtml(
    html.match(/["']title["']\s*:\s*["']([^"']+)["']/iu)?.[1] || heading,
  )
  const description = stripHtml(
    html.match(/<div\b[^>]*id=["']description-text["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/iu)?.[1] || '',
  )
  if (!canonical || !title || title.length > 240 || description.length < 40) return null

  const company = stripHtml(
    html.match(/<div\b[^>]*id=["']company-title["'][^>]*>[\s\S]*?<a\b[^>]*>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/iu)?.[1] || '',
  ) || summary.company
  const location = stripHtml(
    html.match(/<span\b[^>]*class=["'][^"']*\bterr\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu)?.[1] || '',
  ) || summary.location
  const datePosted = html.match(/["']datePosted["']\s*:\s*["']([^"']+)["']/iu)?.[1]
  const salary = flagmaSalary(html, summary, location)
  const employmentType = html.match(/["']employmentType["']\s*:\s*["']([^"']+)["']/iu)?.[1]
  const semanticText = `${title}\n${location}\n${description}`

  return {
    ...summary,
    id: `flagma-${canonical.match(/-rv(\d+)\.html/i)?.[1] || summary.id.replace(/^flagma-/, '')}`,
    title,
    company,
    location,
    url: canonical,
    remote: detectWorkModes(semanticText).includes('remote'),
    postedAt: validDate(datePosted || summary.postedAt),
    employmentType: employmentType || summary.employmentType,
    description: description.slice(0, 4_000),
    ...salary,
  }
}

export const PUBLIC_JOB_BOARDS: PublicBoard[] = [
  { label: 'Remote Source', url: 'https://www.remotesource.com/jobs', remoteByDefault: true },
  { label: 'TaskFavour', url: 'https://www.taskfavour.com/jobs' },
  { label: 'Tech Leads Community', url: 'https://techleadscommunity.com/', remoteByDefault: true },
  { label: '4 Day Week', url: 'https://4dayweek.io/jobs' },
  { label: '80,000 Hours', url: 'https://jobs.80000hours.org/' },
  { label: 'Welcome to the Jungle', url: 'https://www.welcometothejungle.com/en/jobs' },
  { label: 'Working Nomads', url: 'https://www.workingnomads.com/', remoteByDefault: true },
  { label: 'Remote.co', url: 'https://remote.co/remote-jobs', remoteByDefault: true },
  { label: 'Virtual Vocations', url: 'https://www.virtualvocations.com/jobs/', remoteByDefault: true },
  { label: 'Jobspresso', url: 'https://jobspresso.co/jobs/', remoteByDefault: true },
  { label: 'Wellfound', url: 'https://wellfound.com/jobs' },
  { label: 'Dice', url: 'https://www.dice.com/jobs?location=&q=' },
  { label: 'Built In', url: 'https://builtin.com/jobs/remote/software-engineering', usOnly: true, assumeUs: true },
  { label: 'Y Combinator', url: 'https://www.ycombinator.com/jobs/role/software-engineer/united-states', usOnly: true, assumeUs: true },
  { label: 'TechFetch', url: 'https://www.techfetch.com/', usOnly: true, assumeUs: true },
  { label: 'PowerToFly', url: 'https://powertofly.com/jobs/?location=USA', usOnly: true, assumeUs: true },
  { label: 'SimplyHired', url: 'https://www.simplyhired.com/' },
  { label: 'Escape the City', url: 'https://www.escapethecity.org/search/jobs' },
  { label: 'Diversity Jobs Group', url: 'https://diversityjobsgroup.com/job-listings/' },
  {
    label: 'VisaJobSearch',
    url: 'https://www.visajobsearch.com/jobs',
    usOnly: true,
    sponsorshipConfidence: 'verified',
    sponsorshipEvidence: 'Visa-focused board labels roles with sponsorship status',
  },
  {
    label: 'VisaJobFinder',
    url: 'https://visajobfinder.com/usa',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'explicit',
    sponsorshipEvidence: 'Board states listed US roles explicitly offer visa sponsorship',
  },
  {
    label: 'JobsH1B',
    url: 'https://jobsh1b.com/jobs',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'historical',
    sponsorshipEvidence: 'Employer has H-1B sponsorship history; role eligibility is not guaranteed',
  },
  {
    label: 'VisaHire',
    url: 'https://visahire.co/',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'verified',
    sponsorshipEvidence: 'Board checks listing sponsorship intent or recent H-1B sponsor history',
  },
  {
    label: 'Migrate Mate',
    url: 'https://migratemate.co/visa-sponsorship-jobs',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'verified',
    sponsorshipEvidence: 'Visa-focused US board backed by employer sponsorship history',
  },
  {
    label: 'MyVisaJobs',
    url: 'https://www.myvisajobs.com/Search_Visa',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'historical',
    sponsorshipEvidence: 'Employer sponsorship history from US visa/LCA data',
  },
]

function validDate(value: unknown): string {
  const time = Date.parse(String(value || ''))
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString()
}

function locationFromPosting(posting: any): string {
  const raw = Array.isArray(posting?.jobLocation)
    ? posting.jobLocation
    : posting?.jobLocation
      ? [posting.jobLocation]
      : []

  const values = raw
    .map((item: any) => item?.address || item)
    .map((address: any) => [
      address?.addressLocality,
      address?.addressRegion,
      address?.addressCountry?.name || address?.addressCountry,
    ].filter(Boolean).join(', '))
    .filter(Boolean)

  if (values.length) return [...new Set(values)].join('; ')
  if (posting?.jobLocationType === 'TELECOMMUTE') return 'Remote'
  return 'See listing'
}

function boardTags(board: PublicBoard): string[] {
  const tags = [board.label]
  if (board.sponsorshipConfidence === 'explicit') tags.push('Visa sponsorship', 'Explicit sponsorship')
  if (board.sponsorshipConfidence === 'verified') tags.push('Visa sponsorship', 'Verified sponsor')
  if (board.sponsorshipConfidence === 'historical') tags.push('H1B sponsor history')
  if (board.usOnly) tags.push('USA')
  return tags
}

function sponsorshipFields(board: PublicBoard): Pick<Job, 'sponsorshipConfidence' | 'sponsorshipEvidence'> {
  return {
    ...(board.sponsorshipConfidence ? { sponsorshipConfidence: board.sponsorshipConfidence } : {}),
    ...(board.sponsorshipEvidence ? { sponsorshipEvidence: [board.sponsorshipEvidence] } : {}),
  }
}

function jsonLdNodes(value: any): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes)
  const graph = value?.['@graph']
  return graph ? jsonLdNodes(graph) : [value]
}

function parseJsonLd(html: string, board: PublicBoard): Job[] {
  const out: Job[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(html))) {
    let parsed: any
    try {
      parsed = JSON.parse(match[1]!)
    } catch {
      continue
    }

    for (const node of jsonLdNodes(parsed)) {
      const type = node?.['@type']
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))
      if (!isJob || !node?.title) continue

      const url = absoluteUrl(String(node.url || node.sameAs || ''), board.url)
      if (!url) continue
      const location = locationFromPosting(node)
      if (board.usOnly && !board.assumeUs && !detectUsLocation(location)) continue
      const company = stripHtml(node?.hiringOrganization?.name) || board.label
      const description = stripHtml(node.description)

      out.push({
        id: `public-${board.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${url}`,
        title: stripHtml(node.title),
        company,
        location: board.assumeUs && location === 'See listing' ? 'United States' : location,
        url,
        source: 'companies',
        remote: board.remoteByDefault === true
          || node.jobLocationType === 'TELECOMMUTE'
          || /remote|anywhere|worldwide/i.test(`${node.title} ${location} ${description}`),
        tags: boardTags(board),
        postedAt: validDate(node.datePosted),
        employmentType: Array.isArray(node.employmentType) ? node.employmentType[0] : node.employmentType,
        description: description.slice(0, 4000) || undefined,
        ...sponsorshipFields(board),
      })
    }
  }

  return out
}

function looksLikeJobUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase().replace(/\/+$/, '')
  if (!path || path === '/') return false

  if (/\/(?:login|signin|signup|register|pricing|employers?|companies|categories|search)(?:\/|$)/.test(path)) {
    return false
  }

  return /\/(?:jobs?|job|vacanc(?:y|ies)|positions?|openings?|opportunities)\/[a-z0-9][^/]{2,}/i.test(path)
    || /\/job[-_][a-z0-9][a-z0-9_-]{4,}/i.test(path)
}

function parseAnchors(html: string, board: PublicBoard): Job[] {
  if (board.usOnly && !board.assumeUs) return []

  const byUrl = new Map<string, string>()
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(html))) {
    const href = absoluteUrl(match[1]!, board.url)
    if (!href) continue

    let parsed: URL
    try {
      parsed = new URL(href)
    } catch {
      continue
    }
    if (!looksLikeJobUrl(parsed)) continue

    const title = stripHtml(match[2])
    if (title.length < 3 || title.length > 180) continue
    if (/^(apply|view|details?|read more|learn more|save|next|previous)$/i.test(title)) continue

    const existing = byUrl.get(href)
    if (!existing || title.length < existing.length) byUrl.set(href, title)
  }

  const now = new Date().toISOString()
  return [...byUrl.entries()].map(([url, title]) => ({
    id: `public-${board.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${url}`,
    title,
    company: board.label,
    location: board.assumeUs ? 'United States' : board.remoteByDefault ? 'Remote' : 'See listing',
    url,
    source: 'companies',
    remote: board.remoteByDefault === true || /remote|anywhere|worldwide/i.test(title),
    tags: boardTags(board),
    postedAt: now,
    ...sponsorshipFields(board),
  }))
}

export function parsePublicBoardPage(html: string, board: PublicBoard): Job[] {
  const byUrl = new Map<string, Job>()
  for (const job of [...parseJsonLd(html, board), ...parseAnchors(html, board)]) byUrl.set(job.url, job)
  return [...byUrl.values()]
}
