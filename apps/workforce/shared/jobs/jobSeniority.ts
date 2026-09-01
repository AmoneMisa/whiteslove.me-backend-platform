import { matchSeniority } from '@whiteslove/parsing-lexicon'
import type { Job, Seniority } from '../contracts/jobs'

/**
 * Keep Staff, Principal and Lead distinct instead of collapsing all of them to
 * Lead. Title evidence wins; the description is only used as a fallback when a
 * generic title omits the level.
 */
export function detectDetailedJobSeniority(title: string, description = ''): Seniority | null {
  return (matchSeniority(title)?.canonical || matchSeniority(description)?.canonical || null) as Seniority | null
}

export function normalizeJobSeniority(job: Job): Job {
  const seniority = detectDetailedJobSeniority(job.title || '', job.description || '')
  if (!seniority || seniority === job.seniority) return job
  return { ...job, seniority }
}
