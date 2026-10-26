import type { JobActivityRow } from './jobActivity'
import { normalizeCompany } from '../../../shared/hiring/jobCluster'

function pageUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname === '/') return null
    url.hash = ''
    return url.href
  } catch { return null }
}
const timeOf = (value: unknown) => value == null ? null
  : Number.isFinite(new Date(String(value)).getTime()) ? new Date(String(value)).getTime() : null
const titleOf = (value: string) => String(value || '').normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim()
const textOf = (value: string | undefined) => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim()

/** A board's role cluster alone cannot identify the original employer post. */
export function findProbableJobOriginal(rows: JobActivityRow[], now = new Date()) {
  const empty = (status = 'insufficient_evidence') => ({status, candidatePublicId: null,
    confidence: null, evidence: [] as string[], comparedPublicIds: [] as number[], ownershipVerified: false})
  const candidates = rows.flatMap((row) => {
    const job = row.data
    if (job.source !== 'companies' || job.employerType !== 'direct' || !normalizeCompany(job.company)) return []
    const url = pageUrl(job.url)
    const published = timeOf(job.postedAt)
    const description = textOf(job.description)
    if (!url || (published != null && published > now.getTime()) || description.length < 120) return []
    // Several source adapters substitute crawl time when no board date exists.
    // Application-link provenance, not postedAt ordering, supports this finding.
    const related = rows.filter((other) => other.identity_key !== row.identity_key
      && other.data.source !== job.source && pageUrl(other.data.applyUrl) === url
      && normalizeCompany(other.data.company) === normalizeCompany(job.company)
      && titleOf(other.data.title) === titleOf(job.title)
      && textOf(other.data.description) === description)
    return related.length ? [{row, compared: related.map((other) => Number(other.public_id))}] : []
  })
  if (!candidates.length) return empty()
  if (candidates.length > 1) return empty('ambiguous')
  const candidate = candidates[0]!
  return {status: 'candidate', candidatePublicId: Number(candidate.row.public_id), confidence: 'moderate',
    evidence: ['company_source', 'shared_application_page', 'matching_job_content'],
    comparedPublicIds: candidate.compared, ownershipVerified: false}
}
