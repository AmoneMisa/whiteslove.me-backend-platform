import type { Job } from '../../../shared/contracts/jobs'
import { normalizeCompany } from '../../../shared/hiring/jobCluster'

export interface JobActivityRow {
  identity_key: string
  public_id: number | string
  first_seen_at: string | Date
  active: boolean
  data: Job
}

/** Group source-declared publisher types, without claiming recruiter identity. */
export function groupJobPostings(rows: JobActivityRow[], currentIdentity: string) {
  const postings = rows.map((item) => ({
    id: item.data.id, publicId: Number(item.public_id), source: item.data.source,
    title: item.data.title, url: item.data.url, applyUrl: item.data.applyUrl,
    active: item.active, firstSeenAt: item.first_seen_at,
    sourcePublishedAt: item.data.postedAt,
    advertiserType: item.data.employerType === 'direct' ? 'direct'
      : item.data.employerType === 'agency' ? 'agency' : 'unknown',
    current: item.identity_key === currentIdentity,
    matchKind: item.identity_key === currentIdentity ? 'current' : 'same_role',
    company: item.data.company,
    salary: {
      min: item.data.salaryMin ?? null, max: item.data.salaryMax ?? null,
      currency: item.data.salaryCurrency ?? null, period: item.data.salaryPeriod ?? null,
      gross: item.data.salaryGross ?? null, negotiable: item.data.salaryNegotiable === true,
    },
  }))
  type Posting = (typeof postings)[number]
  const groups = new Map<string, {
    key: string; company: string; advertiserType: string;
    contact: null; sameAdvertiser: false; listings: Posting[]
  }>()
  postings.forEach((posting, index) => {
    const company = normalizeCompany(posting.company)
    // Unknown authors stay separate. Shared role/company is not proof that
    // two boards published the same recruiter's advertisement.
    const key = company && posting.advertiserType !== 'unknown'
      ? `${posting.advertiserType}:${company}` : `unknown:${rows[index]!.identity_key}`
    if (!groups.has(key)) groups.set(key, {
      key: `publisher-${groups.size + 1}`, company: posting.company,
      advertiserType: posting.advertiserType, contact: null,
      sameAdvertiser: false, listings: [],
    })
    groups.get(key)!.listings.push(posting)
  })
  return [...groups.values()]
}
