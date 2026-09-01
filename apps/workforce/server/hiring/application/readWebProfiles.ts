import { stateStoreReady, useStateStore } from '~~/server/utils/stateStore'
import { hiringDbEnabled, loadDbCandidates } from '../infrastructure/database'
import type { CvProfile } from '../../../shared/contracts/hiring'

const STORE_KEY = 'hiring:store:v4'
const MAX_AGE_MONTHS = 3
const FALLBACK_TTL_MS = 60_000
const FALLBACK_TIMEOUT_MS = 2_000

type StoredProfile = CvProfile & { lastSeen?: string; ai?: unknown }

function active(profile: CvProfile): boolean {
  if (profile.origin !== 'web') return false
  const activity = Date.parse(profile.activityAt || profile.updatedAt || profile.createdAt || '')
  if (!Number.isFinite(activity)) return false
  const cutoff = new Date()
  cutoff.setUTCMonth(cutoff.getUTCMonth() - MAX_AGE_MONTHS)
  return activity >= cutoff.getTime() && activity <= Date.now() + 48 * 60 * 60 * 1000
}

let fallbackProfiles: CvProfile[] = []
let fallbackAt = 0

async function withTimeout<T>(operation: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Read model for web CVs. A non-empty shared snapshot can still be missing its
 * web rows, so an empty web subset is treated as a cache miss and recovered
 * from Postgres with a short timeout and one-minute negative cache.
 */
export async function getStoredWebCvProfiles(): Promise<CvProfile[]> {
  let stored: StoredProfile[] = []
  try {
    await stateStoreReady()
    const raw = await useStateStore().get(STORE_KEY)
    if (raw) stored = JSON.parse(raw) as StoredProfile[]
  } catch (error) {
    console.warn('[hiring:web] store read failed:', (error as Error).message)
  }

  let web = stored.filter(active)
  if (!web.length && hiringDbEnabled()) {
    if (Date.now() - fallbackAt < FALLBACK_TTL_MS) {
      web = fallbackProfiles
    } else {
      web = (await withTimeout(loadDbCandidates(), [], FALLBACK_TIMEOUT_MS)).filter(active)
      fallbackProfiles = web
      fallbackAt = Date.now()
    }
  }
  return web.map(({ lastSeen: _lastSeen, ai: _ai, ...profile }) => profile)
}
