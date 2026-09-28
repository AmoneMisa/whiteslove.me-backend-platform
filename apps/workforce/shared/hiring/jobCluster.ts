import { createHash } from 'node:crypto'

/**
 * Job clustering and provenance (§37).
 *
 * `identityKey` in the jobs read model is `source:url` -- one posting. A
 * cluster is the *role being advertised*, which may appear on several boards,
 * be reposted monthly, and change recruiter without becoming a different job.
 *
 * The judgement running through this file: ordinary recruiting looks exactly
 * like the suspicious patterns if you squint. Agencies legitimately advertise
 * for many companies, big employers genuinely keep evergreen postings open for
 * years, and reposting a role that did not fill is normal. So every finding
 * here needs either a contradiction or repetition across independent postings,
 * and none of it is a verdict.
 */

export type JobClusterInput = {
  company?: string | null
  title?: string | null
  location?: string | null
  city?: string | null
  country?: string | null
  applicationUrl?: string | null
  recruiterId?: string | null
  salaryUsd?: number | null
  description?: string | null
}

export type JobProvenanceReason =
  | 'copied_job'
  | 'stale_job'
  | 'permanent_reposting'
  | 'recruiter_identity_rotation'
  | 'recruiter_company_identity_mismatch'
  | 'application_destination_changed'
  | 'job_contact_domain_mismatch'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Case, punctuation and legal-form noise folded away, so "Acme LLC" and
 * "ACME, LLC." cluster together. */
export function normalizeCompany(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    // \b is ASCII-only in JavaScript and never fires next to Cyrillic, so
    // "ООО" and "МЧЖ" were never stripped. Unicode lookarounds instead.
    .replace(/(?<![\p{L}\p{N}])(llc|ltd|inc|gmbh|corp|corporation|co|plc|ag|sa|srl|oy|ab|as|llp|ооо|зао|оао|пао|тоо|мчж)(?![\p{L}\p{N}])/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Seniority and contract noise removed, so "Senior Backend Engineer (remote)"
 * and "Backend Engineer" are the same role. */
export function normalizeTitle(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\((?:[^)]*)\)/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])(senior|junior|middle|lead|principal|staff|intern|trainee|remote|hybrid|onsite|full[-\s]?time|part[-\s]?time|contract|стаж\p{L}*|удал[её]нн\p{L}*)(?![\p{L}\p{N}])/gu, ' ')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
}

/**
 * The cluster key: company, role and locality.
 *
 * Deliberately excludes salary, description and the application URL. Those
 * change between postings of the same job, and including them would split one
 * role into a new cluster every time the recruiter edited it -- which would
 * make repost detection impossible, since every repost would look new.
 */
export function jobClusterKey(job: JobClusterInput): string | null {
  return jobClusterIdentity(job)?.key ?? null
}

export type JobClusterIdentity = {
  key: string
  country: string
  company: string
  title: string
  locality: string
}

/** The cluster key together with the normalised parts it hashes, which the
 * job_clusters row stores so a cluster can be found by company. */
export function jobClusterIdentity(job: JobClusterInput): JobClusterIdentity | null {
  const company = normalizeCompany(job.company)
  const title = normalizeTitle(job.title)
  if (!company || !title) return null
  const locality = String(job.city ?? job.location ?? '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const country = String(job.country ?? '').toUpperCase()
  return { key: sha256([country, company, title, locality].join('\u0000')), country, company, title, locality }
}

/** Registrable-ish domain of a URL, or null when it is not a usable URL. */
export function domainOf(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`)
    const host = url.hostname.toLocaleLowerCase('en-US').replace(/^www\./, '')
    return host || null
  } catch {
    return null
  }
}

const emailDomain = (value: unknown): string | null => {
  const text = String(value ?? '').trim()
  const at = text.lastIndexOf('@')
  if (at < 1) return null
  const host = text.slice(at + 1).toLocaleLowerCase('en-US')
  return host.includes('.') ? host : null
}

/** Free mailbox providers say nothing about which company a recruiter is for,
 * so a mismatch against one is not evidence. */
const FREE_MAIL = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'mail.ru', 'yandex.ru',
  'icloud.com', 'proton.me', 'protonmail.com', 'inbox.ru', 'list.ru', 'bk.ru', 'ukr.net',
])

export type JobPosting = {
  identityKey: string
  clusterKey: string | null
  firstSeenAt?: string | Date | null
  lastSeenAt?: string | Date | null
  postedAt?: string | Date | null
  active?: boolean
  applicationUrl?: string | null
  contactEmail?: string | null
  companyDomain?: string | null
  recruiterId?: string | null
  company?: string | null
}

export type JobProvenanceFinding = {
  reasonCode: JobProvenanceReason
  independentCount: number
  detail: Record<string, unknown>
}

const DAY_MS = 24 * 60 * 60 * 1000

const timeOf = (value: unknown): number | null => {
  if (!value) return null
  const at = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(at) ? at : null
}

/** A role open this long without ever being refreshed is stale rather than
 * live. Generous, because genuine hard-to-fill roles do run for months. */
export const STALE_AFTER_DAYS = 180
/** Reposts within one cluster before "permanent" is a fair description. */
export const PERMANENT_REPOST_COUNT = 6
/** Independent postings needed before a recruiter pattern is a finding. */
export const MIN_INDEPENDENT_POSTINGS = 3

/**
 * Provenance findings for one job cluster.
 *
 * `postings` are the postings that resolved to this cluster, oldest first.
 */
export function assessJobProvenance(postings: JobPosting[], options: { now?: Date } = {}): {
  findings: JobProvenanceFinding[]
  postingCount: number
  evidenceOnly: true
} {
  const now = timeOf(options.now) ?? Date.now()
  const rows = (postings ?? []).filter(Boolean)
  const findings: JobProvenanceFinding[] = []
  if (!rows.length) return { findings, postingCount: 0, evidenceOnly: true }

  // Repeated postings of one role. Evergreen recruiting is legitimate, so this
  // needs a high count before it says anything, and it is described as
  // reposting rather than as deception.
  if (rows.length >= PERMANENT_REPOST_COUNT) {
    findings.push({
      reasonCode: 'permanent_reposting',
      independentCount: rows.length,
      detail: { postings: rows.length, note: 'evergreen recruiting is legitimate; this is a description, not a finding of fraud' },
    })
  }

  // A posting still active long after it was published and never refreshed.
  for (const row of rows) {
    if (row.active === false) continue
    const posted = timeOf(row.postedAt ?? row.firstSeenAt)
    const refreshed = timeOf(row.lastSeenAt)
    if (posted === null) continue
    const ageDays = (now - posted) / DAY_MS
    const refreshedRecently = refreshed !== null && now - refreshed < 30 * DAY_MS
    if (ageDays > STALE_AFTER_DAYS && !refreshedRecently) {
      findings.push({
        reasonCode: 'stale_job',
        independentCount: 1,
        detail: { identityKey: row.identityKey, ageDays: Math.round(ageDays) },
      })
    }
  }

  // Where applications go, changing over the life of one role.
  const destinations = [...new Set(rows.map((row) => domainOf(row.applicationUrl)).filter(Boolean) as string[])]
  if (destinations.length > 1) {
    findings.push({
      reasonCode: 'application_destination_changed',
      independentCount: destinations.length,
      detail: { destinations },
    })
  }

  // Several recruiters on one role. Handovers happen, so this needs more than
  // two and is reported as rotation rather than impersonation.
  const recruiters = [...new Set(rows.map((row) => row.recruiterId).filter(Boolean) as string[])]
  if (recruiters.length >= MIN_INDEPENDENT_POSTINGS) {
    findings.push({
      reasonCode: 'recruiter_identity_rotation',
      independentCount: recruiters.length,
      detail: { recruiters: recruiters.length },
    })
  }

  // A contact address whose domain contradicts the company's own, ignoring
  // free mailboxes, which say nothing either way.
  for (const row of rows) {
    const contact = emailDomain(row.contactEmail)
    const company = domainOf(row.companyDomain)
    if (!contact || !company || FREE_MAIL.has(contact)) continue
    if (contact !== company && !contact.endsWith(`.${company}`) && !company.endsWith(`.${contact}`)) {
      findings.push({
        reasonCode: 'job_contact_domain_mismatch',
        independentCount: 1,
        detail: { contactDomain: contact, companyDomain: company },
      })
    }
  }

  return { findings: dedupeFindings(findings), postingCount: rows.length, evidenceOnly: true }
}

/**
 * Whether a recruiter advertising for many companies is worth noting.
 *
 * It usually is not: that is what an agency does. This reports only when the
 * recruiter presents themselves as the employer while advertising for several
 * unrelated ones, which is the actual §37 pattern.
 */
export function assessRecruiterCompanyIdentity(
  postings: { company?: string | null, claimsToBeEmployer?: boolean }[],
  options: { minimumCompanies?: number } = {},
): { findings: JobProvenanceFinding[], distinctCompanies: number, evidenceOnly: true } {
  const minimum = options.minimumCompanies ?? MIN_INDEPENDENT_POSTINGS
  const rows = (postings ?? []).filter(Boolean)
  const companies = new Set(rows.map((row) => normalizeCompany(row.company)).filter(Boolean))
  const claimingRows = rows.filter((row) => row.claimsToBeEmployer === true)
  const claimedCompanies = new Set(claimingRows.map((row) => normalizeCompany(row.company)).filter(Boolean))

  const findings: JobProvenanceFinding[] = []
  if (claimedCompanies.size >= minimum) {
    findings.push({
      reasonCode: 'recruiter_company_identity_mismatch',
      independentCount: claimedCompanies.size,
      detail: { claimedCompanies: claimedCompanies.size, note: 'an agency advertising for many companies is ordinary; claiming to BE each of them is not' },
    })
  }
  return { findings, distinctCompanies: companies.size, evidenceOnly: true }
}

/** Two postings of the same role from different sources with identical text. */
export function detectCopiedJob(
  left: { description?: string | null, source?: string | null, company?: string | null },
  right: { description?: string | null, source?: string | null, company?: string | null },
): JobProvenanceFinding | null {
  const leftText = String(left?.description ?? '').replace(/\s+/gu, ' ').trim()
  const rightText = String(right?.description ?? '').replace(/\s+/gu, ' ').trim()
  if (leftText.length < 200 || rightText.length < 200) return null
  if (sha256(leftText) !== sha256(rightText)) return null
  // Identical text under the same company across sources is a cross-post, not
  // a copy. It is only notable when the company differs.
  if (normalizeCompany(left.company) === normalizeCompany(right.company)) return null
  return {
    reasonCode: 'copied_job',
    independentCount: 1,
    detail: { leftSource: left.source ?? null, rightSource: right.source ?? null },
  }
}

function dedupeFindings(findings: JobProvenanceFinding[]): JobProvenanceFinding[] {
  const byCode = new Map<string, JobProvenanceFinding>()
  for (const finding of findings) {
    const existing = byCode.get(finding.reasonCode)
    if (!existing) { byCode.set(finding.reasonCode, finding); continue }
    existing.independentCount = Math.max(existing.independentCount, finding.independentCount)
  }
  return [...byCode.values()]
}
