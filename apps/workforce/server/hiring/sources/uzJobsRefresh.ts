// Public, anonymous rows from the UzJobs closed-resume index.
//
// The board intentionally hides names and direct contacts from logged-out
// visitors. We preserve that boundary: only the public id, desired categories,
// region and last-visit date are stored, and contact remains "via platform".

import { emptyWebCursor, loadWebCursors, saveWebCursor } from '../../../shared/hiring/hiringCursors'
import { recordWebDiagnostic, type SourceRun, type WebSourceDiagnostic } from '../../../shared/hiring/hiringDiagnostics'
import { normalizeCandidate } from '../../utils/hiring/hiringNormalize'
import type { CvProfile } from '~~/shared/contracts/hiring'
import { hiringDbEnabled, saveDbCandidates } from '../infrastructure/database'
import { persistWebProfiles } from '../webProfilePersistence'
import { cityFrom } from '../../../shared/hiring/webFields'
import { parseUzJobsRows } from '../../../shared/hiring/uzJobsFields'
import { crawlUzJobsPages } from '../../../shared/hiring/sources/uzJobsCrawler'
import {
  hiringUzJobsSourceHandles,
  listUzJobsSources,
  UZJOBS_SOURCE_COUNTRY,
  UZJOBS_SOURCE_KEY,
  UZJOBS_SOURCE_LABEL,
  uzJobsProfileUrl,
} from '../../../shared/hiring/sources/uzJobsSource'

export { hiringUzJobsSourceHandles, listUzJobsSources }

/** Parse one public listing page without network or storage side effects. */
export function parseUzJobsPage(html: string): CvProfile[] {
  return parseUzJobsRows(html).map(({ id, roles, region, activityAt, activityText }) => {
    const originalText = [...roles, region, activityText].join('\n')
    const url = uzJobsProfileUrl(id)
    return normalizeCandidate({
      id: `web-${UZJOBS_SOURCE_KEY}-${id}`,
      source: 'telegram',
      origin: 'web',
      sourceKey: UZJOBS_SOURCE_KEY,
      sourceLabel: UZJOBS_SOURCE_LABEL,
      sourceCountry: UZJOBS_SOURCE_COUNTRY,
      country: UZJOBS_SOURCE_COUNTRY,
      name: '',
      role: roles[0]!,
      professions: roles,
      city: cityFrom(region, UZJOBS_SOURCE_COUNTRY) || region,
      url,
      publishedAt: null,
      updatedAt: activityAt,
      activityAt,
      createdAt: activityAt,
      originalText,
      description: originalText,
      tags: [UZJOBS_SOURCE_LABEL, 'Web CV', 'Uzbekistan', 'Anonymous profile'],
      contact: url,
      contactType: 'platform',
    })
  })
}

export async function crawlUzJobsSource() {
  const cursor = (await loadWebCursors()).get(UZJOBS_SOURCE_KEY) || emptyWebCursor(UZJOBS_SOURCE_KEY)
  return crawlUzJobsPages(cursor, parseUzJobsPage)
}

export async function refreshHiringUzJobsSource(
  handle: string,
): Promise<{ fetched: number; candidates: number; stored: number } | null> {
  if (!hiringUzJobsSourceHandles().some((item) => item.toLowerCase() === handle.toLowerCase())) return null
  const checkedAt = new Date().toISOString()
  const startedAt = Date.now()
  const cursor = (await loadWebCursors()).get(UZJOBS_SOURCE_KEY) || emptyWebCursor(UZJOBS_SOURCE_KEY)

  try {
    const result = await crawlUzJobsPages(cursor, parseUzJobsPage)
    const activities = result.profiles.map((profile) => profile.activityAt || '').filter(Boolean).sort()
    const diagnostic: WebSourceDiagnostic = {
      handle: `web:${UZJOBS_SOURCE_KEY}`,
      key: UZJOBS_SOURCE_KEY,
      label: UZJOBS_SOURCE_LABEL,
      country: UZJOBS_SOURCE_COUNTRY,
      status: result.profiles.length ? 'ok' : 'empty',
      fetched: result.fetched,
      candidates: result.profiles.length,
      pages: result.pages,
      blocks: result.fetched,
      parsed: result.profiles.length,
      rejected: Math.max(0, result.fetched - result.profiles.length),
      duplicate: 0,
      expired: 0,
      shown: 0,
      fetchDurationMs: Date.now() - startedAt,
      newestActivityAt: activities.at(-1) || null,
      oldestActivityAt: activities[0] || null,
      lastSeenProfileId: result.cursor.lastSeenProfileId,
      lastSuccessAt: result.cursor.lastSuccessAt,
      reachedCursor: false,
      checkedAt,
    }
    const persisted = await persistWebProfiles(result.profiles, diagnostic, UZJOBS_SOURCE_KEY)
    diagnostic.shown = persisted.shown
    diagnostic.expired = persisted.expired
    recordWebDiagnostic(diagnostic)
    await saveWebCursor(result.cursor)
    console.log(
      `[hiring:web] ${UZJOBS_SOURCE_KEY} pages=${result.pages} fetched=${result.fetched}`
      + ` candidates=${result.profiles.length} shown=${persisted.shown} store=${persisted.stored}`,
    )
    return { fetched: result.fetched, candidates: result.profiles.length, stored: persisted.stored }
  } catch (error) {
    const diagnostic: SourceRun = {
      handle: `web:${UZJOBS_SOURCE_KEY}`,
      country: UZJOBS_SOURCE_COUNTRY,
      status: 'error',
      fetched: 0,
      candidates: 0,
      checkedAt,
      error: (error as Error).message,
    }
    recordWebDiagnostic({
      ...diagnostic,
      key: UZJOBS_SOURCE_KEY,
      label: UZJOBS_SOURCE_LABEL,
      pages: 0,
      blocks: 0,
      parsed: 0,
      rejected: 0,
      duplicate: 0,
      expired: 0,
      shown: 0,
      fetchDurationMs: Date.now() - startedAt,
      newestActivityAt: null,
      oldestActivityAt: null,
      lastSeenProfileId: cursor.lastSeenProfileId,
      lastSuccessAt: cursor.lastSuccessAt,
      reachedCursor: false,
    })
    if (hiringDbEnabled()) await saveDbCandidates([], diagnostic)
    throw error
  }
}
