import type { SourceRun } from '../../../shared/hiring/hiringDiagnostics'
import { hiringDbEnabled, saveDbCandidates } from '../infrastructure/database'
import { emptyWebCursor, loadWebCursors, saveWebCursor } from '../../../shared/hiring/hiringCursors'
import { normalizeCandidate } from '../../utils/hiring/hiringNormalize'
import { persistWebProfiles } from '../webProfilePersistence'
import { parseIshBorProfile } from '../../../shared/hiring/ishBorProfile'
import { crawlIshBorPages } from '../../../shared/hiring/sources/ishBorCrawler'
import { hiringIshBorSourceHandles, ISHBOR_SOURCE_KEY } from '../../../shared/hiring/sources/ishBorSource'

async function fetchProfiles(cursor = emptyWebCursor(ISHBOR_SOURCE_KEY)) {
  return crawlIshBorPages(
    cursor,
    (summary, detailHtml) => parseIshBorProfile(summary, detailHtml, normalizeCandidate),
  )
}

/** One crawl of the ish-bor board, without storing anything. For diagnostics. */
export async function crawlIshBorSource() {
  const cursor = (await loadWebCursors()).get(ISHBOR_SOURCE_KEY) || emptyWebCursor(ISHBOR_SOURCE_KEY)
  return fetchProfiles(cursor)
}

export { hiringIshBorSourceHandles }

export async function refreshHiringIshBorSource(
  handle: string,
): Promise<{ fetched: number; candidates: number; stored: number } | null> {
  if (!hiringIshBorSourceHandles().some((item) => item.toLowerCase() === handle.toLowerCase())) return null
  const checkedAt = new Date().toISOString()
  try {
    const cursor = (await loadWebCursors()).get(ISHBOR_SOURCE_KEY) || emptyWebCursor(ISHBOR_SOURCE_KEY)
    const result = await fetchProfiles(cursor)
    const diagnostic: SourceRun = {
      handle: `web:${ISHBOR_SOURCE_KEY}`,
      country: 'UZ',
      status: result.profiles.length ? 'ok' : 'empty',
      fetched: result.fetched,
      candidates: result.profiles.length,
      checkedAt,
    }
    const persisted = await persistWebProfiles(result.profiles, diagnostic, ISHBOR_SOURCE_KEY)
    await saveWebCursor(result.cursor)
    console.log(
      `[hiring:web] ${ISHBOR_SOURCE_KEY} fetched=${result.fetched}`
      + ` candidates=${result.profiles.length} store=${persisted.stored}`,
    )
    return { fetched: result.fetched, candidates: result.profiles.length, stored: persisted.stored }
  } catch (error) {
    const diagnostic: SourceRun = {
      handle: `web:${ISHBOR_SOURCE_KEY}`,
      country: 'UZ',
      status: 'error',
      fetched: 0,
      candidates: 0,
      checkedAt,
      error: (error as Error).message,
    }
    if (hiringDbEnabled()) await saveDbCandidates([], diagnostic)
    throw error
  }
}
