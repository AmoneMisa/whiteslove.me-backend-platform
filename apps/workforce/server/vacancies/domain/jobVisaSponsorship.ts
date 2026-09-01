import {
  detectVisaSponsorshipWording,
} from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import type { Job, SponsorshipConfidence } from '../../utils/jobTypes'

export { TEMPORARY_WORK_AUTH_RE } from '@whiteslove/parsing-lexicon/hiring-source-semantics'

export type VisaSponsorshipStatus =
  | 'explicit'
  | 'verified'
  | 'historical'
  | 'not_offered'
  | 'unknown'

function primarySponsorshipText(job: Pick<Job, 'title' | 'description' | 'tags'>): string {
  return [job.title, job.description, ...(job.tags || [])].filter(Boolean).join(' ')
}

function allSponsorshipText(job: Pick<Job, 'title' | 'description' | 'tags' | 'sponsorshipEvidence'>): string {
  return [primarySponsorshipText(job), ...(job.sponsorshipEvidence || [])].filter(Boolean).join(' ')
}

/**
 * Classify sponsorship evidence conservatively. Explicit negative wording always
 * wins over board/company history so a role that says "no sponsorship" is never
 * surfaced as sponsor-friendly merely because the employer sponsored before.
 * Historical evidence is metadata, not an explicit promise for this vacancy, so
 * it must not be fed into the explicit-wording matcher.
 */
export function visaSponsorshipStatus(
  job: Pick<Job,
    | 'title'
    | 'description'
    | 'tags'
    | 'foreignerFriendly'
    | 'sponsorshipConfidence'
    | 'sponsorshipEvidence'
  >,
): VisaSponsorshipStatus {
  const primaryText = primarySponsorshipText(job)
  const allText = allSponsorshipText(job)

  if (detectVisaSponsorshipWording(allText) === 'notOffered') return 'not_offered'

  if (detectVisaSponsorshipWording(primaryText) === 'offered') {
    return job.sponsorshipConfidence === 'verified' ? 'verified' : 'explicit'
  }

  const confidence = job.sponsorshipConfidence as SponsorshipConfidence | undefined
  if (confidence === 'explicit' || confidence === 'verified' || confidence === 'historical') {
    return confidence
  }

  // Preserve the existing enrichment signal. It is already based on positive
  // visa/foreigner wording; treating it as explicit avoids throwing away useful
  // detections while still keeping pure unknowns out of the sponsorship filter.
  if (job.foreignerFriendly === true) return 'explicit'

  return 'unknown'
}

/**
 * USA "For foreigners" means there is actual positive sponsorship evidence:
 * explicit/verified wording, historical sponsor evidence, or the legacy positive
 * enrichment flag. Unknown vacancies (including empty descriptions) are not
 * silently treated as sponsor-friendly.
 */
export function keepUsaForeignerCandidate(
  job: Parameters<typeof visaSponsorshipStatus>[0],
): boolean {
  const status = visaSponsorshipStatus(job)
  return status === 'explicit' || status === 'verified' || status === 'historical'
}
