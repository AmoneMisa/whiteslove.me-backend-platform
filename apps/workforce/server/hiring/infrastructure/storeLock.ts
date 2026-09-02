import { randomUUID } from 'node:crypto'
import { useStateStore } from '~~/server/utils/support/stateStore'

const LOCK_KEY = 'hiring:store:v4:write-lock'
const LOCK_TTL_MS = 60_000
const LOCK_WAIT_MS = 30_000
const RETRY_MS = 40

/**
 * Serialize only the short hiring snapshot read/merge/write section. Network
 * crawling stays concurrent; the lock prevents parallel source refreshes from
 * overwriting one another's rows.
 */
export async function withHiringStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const store = useStateStore()
  const token = randomUUID()
  const deadline = Date.now() + LOCK_WAIT_MS

  while (Date.now() < deadline) {
    const acquired = await store.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX')
    if (acquired === 'OK') {
      try {
        return await operation()
      } finally {
        try {
          await store.compareAndDelete(LOCK_KEY, token)
        } catch (error) {
          console.warn('[hiring] failed to release store lock:', (error as Error).message)
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
  }

  throw new Error('timed out waiting for hiring store write lock')
}
