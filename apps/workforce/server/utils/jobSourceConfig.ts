import type { JobSource } from './jobTypes'

export type JobSourceAvailabilityMode = 'feed' | 'ingestion'

function enabledByFeatureFlag(source: JobSource): boolean {
  switch (source) {
    case 'hh':
      return process.env.HH_JOB_SOURCE !== 'off'
    case 'rss':
      return process.env.RSS_DEFAULTS !== 'off' || Boolean(process.env.RSS_FEEDS)
    case 'companies':
      return process.env.COMPANIES_SOURCE !== 'off'
    case 'linkedin':
      return process.env.LINKEDIN_SOURCE !== 'off'
    case 'facebook':
    case 'threads':
      return String(process.env.SOCIAL_JOB_SOURCE || 'on').toLowerCase() !== 'off'
    case 'devkg':
      return process.env.DEVKG_SOURCE !== 'off'
    case 'ishgo':
      return process.env.ISHGO_SOURCE !== 'off'
    case 'itjobsuz':
      return process.env.ITJOBS_UZ_SOURCE !== 'off'
    case 'telegram':
      return process.env.TELEGRAM_SOURCE !== 'off'
    case 'olx':
      return process.env.OLX_SOURCE === 'on'
    default:
      return true
  }
}

function hasRequiredCredentials(source: JobSource): boolean {
  if (source === 'adzuna') {
    return Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY)
  }
  if (source === 'jooble') return Boolean(process.env.JOOBLE_KEY)
  return true
}

function hasIngestionTransport(source: JobSource): boolean {
  if (source !== 'facebook' && source !== 'threads') return true
  return Boolean(process.env.HIRING_SOCIAL_API_URL)
    && String(process.env.QUEUE_INTERNAL_KEY || '').length >= 16
}

/**
 * Source availability has two intentionally different meanings:
 * - feed: should persisted rows from this source be selectable/visible;
 * - ingestion: can this process fetch new rows from the source right now.
 *
 * Keeping both meanings here prevents the read API and worker from silently
 * growing separate copies of feature flags and credential requirements.
 */
export function isJobSourceAvailable(
  source: JobSource,
  mode: JobSourceAvailabilityMode = 'feed',
): boolean {
  if (!enabledByFeatureFlag(source) || !hasRequiredCredentials(source)) return false
  return mode === 'feed' || hasIngestionTransport(source)
}
