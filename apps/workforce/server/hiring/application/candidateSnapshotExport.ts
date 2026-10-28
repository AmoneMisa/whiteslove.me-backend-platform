import { useStateStore } from '~~/server/utils/support/stateStore'
import type { CvProfile } from '../../../shared/contracts/hiring'
import { listDbCandidatesPage } from '../infrastructure/database'
import { reconcileCandidateIndex } from '../../utils/hiring/hiringElastic'

// With HIRING_STORE=postgres the table is the store, but readers that have not moved yet (the feed's fallback, share
// previews) and a switch back to the snapshot still read the JSON value. It is produced here: page by page from the
// table, written in pieces, at most every few minutes. The search index is reconciled with the table every six hours.

const STORE_KEY = 'hiring:store:v4'
const STORE_TTL_SECONDS = 100 * 86_400
const PAGE = 1000
const MIN_INTERVAL_MS = (Number(process.env.HIRING_SNAPSHOT_EXPORT_MIN_INTERVAL_SECONDS) || 300) * 1000
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000

type Page = (afterId: number, limit: number) => Promise<{ profiles: unknown[]; lastId: number }>

/** The live candidates as the JSON array the snapshot has always held. An empty table is not published. */
export async function* candidateSnapshotPieces(page: Page = listDbCandidatesPage): AsyncGenerator<string> {
  let after = 0
  let count = 0
  yield '['
  for (;;) {
    const next = await page(after, PAGE)
    if (!next.profiles.length) break
    yield (count ? ',' : '') + next.profiles.map((profile) => JSON.stringify(profile)).join(',')
    count += next.profiles.length
    after = next.lastId
  }
  if (!count) throw new Error('no current candidates in the database; snapshot export skipped')
  yield ']'
}

async function* livePages(): AsyncGenerator<CvProfile[]> {
  let after = 0
  for (;;) {
    const next = await listDbCandidatesPage(after, PAGE)
    if (!next.profiles.length) return
    yield next.profiles
    after = next.lastId
  }
}

let requested = false
let running: Promise<void> | null = null
let lastExportAt = 0
let lastReconcileAt = 0

async function run() {
  while (requested) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastExportAt)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    requested = false
    lastExportAt = Date.now()
    try {
      await useStateStore().setStream(STORE_KEY, candidateSnapshotPieces(), 'EX', STORE_TTL_SECONDS)
    } catch (error) {
      console.error('[hiring:snapshot] export from PostgreSQL failed:', (error as Error).message)
    }
    if (Date.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      try {
        await reconcileCandidateIndex(livePages())
        lastReconcileAt = Date.now()
      } catch (error) {
        console.error('[hiring:elasticsearch] reconcile failed:', (error as Error).message)
      }
    }
  }
}

/** Ask for an export; one runs at a time, at most every MIN_INTERVAL_MS, and again if asked meanwhile. */
export function scheduleCandidateSnapshotExport(): Promise<void> {
  requested = true
  running ??= run().finally(() => { running = null })
  return running
}
