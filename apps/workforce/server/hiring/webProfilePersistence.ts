import { useStateStore } from '~~/server/utils/stateStore'

import type { CvProfile } from '../../shared/contracts/hiring'
import type { SourceRun } from '../../shared/hiring/hiringDiagnostics'
import { cutoffDate } from '../../shared/hiring/webFields'
import { hiringDbEnabled, loadDbCandidates, saveDbCandidates } from './infrastructure/database'
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

export async function persistWebProfiles(
  profiles: CvProfile[],
  diagnostic: SourceRun,
  sourceKey: string,
): Promise<PersistWebProfilesResult> {
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
    return { stored: kept.length, shown, expired: Math.max(0, beforeRetention - shown) }
  })

  if (hiringDbEnabled()) await saveDbCandidates(profiles, diagnostic)
  return persisted
}
