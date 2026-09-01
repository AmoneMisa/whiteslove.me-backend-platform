import type { SourceRun } from '../../../shared/hiring/hiringDiagnostics'
import {
  enabledSecondaryWebSources,
  type SecondaryWebSourceKey,
} from '../../../shared/hiring/sources/secondaryWebSources'
import { hiringDbEnabled, saveDbCandidates } from '../infrastructure/database'
import { persistWebProfiles } from '../webProfilePersistence'
import { crawlAmountwork } from './secondary/amountwork'
import { crawlLayboard } from './secondary/layboard'
import { crawlNovaRobota } from './secondary/novaRobota'

const CRAWLERS = {
  'novarobota-ua': crawlNovaRobota,
  'layboard-kz': crawlLayboard,
  'amountwork-ro': crawlAmountwork,
} as const

export async function crawlSecondaryWebSource(key: string) {
  const crawl = CRAWLERS[key as SecondaryWebSourceKey]
  if (!crawl) throw new Error(`unknown secondary web source: ${key}`)
  return crawl()
}

export async function refreshHiringSecondaryWebSource(
  handle: string,
): Promise<{ fetched: number; candidates: number; stored: number } | null> {
  const key = handle.replace(/^web:/i, '').toLowerCase() as SecondaryWebSourceKey
  const source = enabledSecondaryWebSources().find((item) => item.key === key)
  if (!source) return null

  const checkedAt = new Date().toISOString()

  try {
    const result = await crawlSecondaryWebSource(key)
    const diagnostic: SourceRun = {
      handle: `web:${key}`,
      country: source.country,
      status: result.profiles.length ? 'ok' : 'empty',
      fetched: result.fetched,
      candidates: result.profiles.length,
      checkedAt,
    }
    const persisted = await persistWebProfiles(result.profiles, diagnostic, key)
    console.log(
      `[hiring:web] ${key} fetched=${result.fetched}`
      + ` candidates=${result.profiles.length} store=${persisted.stored}`,
    )
    return {
      fetched: result.fetched,
      candidates: result.profiles.length,
      stored: persisted.stored,
    }
  } catch (error) {
    const diagnostic: SourceRun = {
      handle: `web:${key}`,
      country: source.country,
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
