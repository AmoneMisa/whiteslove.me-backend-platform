import { useStateStore } from './stateStore'
import type { Job } from './jobTypes'

const STORE_KEY = 'jobs:store:v4'
const MEMORY_TTL_MS = 60_000

type StoredJob = Job & {
  lastSeen?: string
  ai?: unknown
}

let memoryStore: Job[] = []
let memoryValidUntil = 0

function publicJobs(list: StoredJob[]): Job[] {
  return list.map(({ lastSeen: _lastSeen, ai: _ai, ...job }) => job)
}

/**
 * Read-only vacancy snapshot used by the jobs API.
 *
 * The writer lives in jobs-worker. This module deliberately does not import any
 * source adapters, crawlers, AI enrichment or refresh orchestration, so serving
 * /jobs-feed can never start ingestion work.
 */
export async function getStoredJobsSnapshot(): Promise<Job[]> {
  if (Date.now() < memoryValidUntil) return memoryStore

  try {
    const raw = await useStateStore().get(STORE_KEY)
    if (raw) {
      memoryStore = publicJobs(JSON.parse(raw) as StoredJob[])
      memoryValidUntil = Date.now() + MEMORY_TTL_MS
      return memoryStore
    }
  } catch (error) {
    console.warn('[jobs:snapshot] failed to read persistent snapshot:', (error as Error).message)
  }

  return memoryStore
}
