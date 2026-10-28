import { useStateStore } from '~~/server/utils/support/stateStore'

import type { CvProfile } from '../../shared/contracts/hiring'
import type { SourceRun } from '../../shared/hiring/hiringDiagnostics'
import { cutoffDate } from '../../shared/hiring/webFields'
import { countDbCandidates, hiringDbEnabled, hiringStoreFromDatabase, loadDbCandidates, saveDbCandidates } from './infrastructure/database'
import { indexCandidatesIncremental, syncCandidateIndex } from '../utils/hiring/hiringElastic'
import { scheduleCandidateSnapshotExport } from './application/candidateSnapshotExport'
import { withHiringStoreLock } from './infrastructure/storeLock'

const STORE_KEY = 'hiring:store:v4'
const STORE_TTL_SECONDS = 100 * 86_400

type StoredProfile = CvProfile & { lastSeen?: string; ai?: unknown }

function storeKey(profile: CvProfile): string {
  return profile.url || profile.id
}

export interface PersistWebProfilesResult {
  /** Everything in the store after the write, all sources included. */
  stored: number
  /** Profiles from this source still inside the retention window. */
  shown: number
  /** Profiles from this source the retention window dropped. */
  expired: number
}

/**
 * The table is the store: only the profiles of this crawl are written (retention is the table's: pruneDbCandidates),
 * the search index gets just those, and the snapshot is exported from the table later. Nothing is read whole.
 * `expired` counts what this crawl brought that is already outside the window; the old figure also counted stored
 * profiles of the source that had aged out meanwhile, which needs the whole list.
 */
async function persistWebProfilesToPostgres(profiles: CvProfile[], diagnostic: SourceRun): Promise<PersistWebProfilesResult> {
  const now = new Date().toISOString()
  const cutoff = cutoffDate().getTime()
  const inWindow = profiles
    .map((profile) => ({ ...profile, lastSeen: now }) as StoredProfile)
    .filter((profile) => {
      const time = Date.parse(profile.activityAt || profile.updatedAt || profile.createdAt || '')
      return Number.isFinite(time) && time >= cutoff && time <= Date.now() + 48 * 60 * 60 * 1000
    })
  await saveDbCandidates(profiles, diagnostic)
  try {
    await indexCandidatesIncremental(inWindow)
  } catch (error) {
    console.warn('[hiring:elasticsearch] candidate sync failed:', (error as Error).message)
  }
  void scheduleCandidateSnapshotExport()
  return {
    stored: await countDbCandidates(),
    shown: inWindow.length,
    expired: Math.max(0, profiles.length - inWindow.length),
  }
}

export async function persistWebProfiles(
  profiles: CvProfile[],
  diagnostic: SourceRun,
  sourceKey: string,
): Promise<PersistWebProfilesResult> {
  if (hiringStoreFromDatabase()) return persistWebProfilesToPostgres(profiles, diagnostic)
  const persisted = await withHiringStoreLock(async () => {
    const now = new Date().toISOString()
    let existing: StoredProfile[] = []
    try {
      const raw = await useStateStore().get(STORE_KEY)
      if (raw) existing = JSON.parse(raw) as StoredProfile[]
    } catch {
      // If the persistent snapshot is cold, hydrate from Postgres below before writing a new store.
    }
    if (!existing.length && hiringDbEnabled()) {
      existing = (await loadDbCandidates()).map((profile) => ({ ...profile, lastSeen: now }))
    }

    const byKey = new Map<string, StoredProfile>()
    for (const profile of existing) byKey.set(storeKey(profile), profile)
    for (const profile of profiles) byKey.set(storeKey(profile), { ...profile, lastSeen: now })

    const cutoff = cutoffDate().getTime()
    const fromSource = (profile: StoredProfile) => profile.sourceKey === sourceKey
    const beforeRetention = [...byKey.values()].filter(fromSource).length
    const kept = [...byKey.values()].filter((profile) => {
      const time = Date.parse(profile.activityAt || profile.updatedAt || profile.createdAt || '')
      return Number.isFinite(time) && time >= cutoff && time <= Date.now() + 48 * 60 * 60 * 1000
    })

    await useStateStore().set(STORE_KEY, JSON.stringify(kept), 'EX', STORE_TTL_SECONDS)
    const shown = kept.filter(fromSource).length
    return {
      stored: kept.length,
      shown,
      expired: Math.max(0, beforeRetention - shown),
      snapshot: kept,
    }
  })

  void syncCandidateIndex(persisted.snapshot).catch((error) => {
    console.warn('[hiring:elasticsearch] candidate sync failed:', (error as Error).message)
  })

  if (hiringDbEnabled()) await saveDbCandidates(profiles, diagnostic)
  return {
    stored: persisted.stored,
    shown: persisted.shown,
    expired: persisted.expired,
  }
}
