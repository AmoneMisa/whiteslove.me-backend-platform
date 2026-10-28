import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Persistent filesystem-backed key/value store for hot JSON snapshots, TTL
// caches and short cross-request locks. State lives on the Docker volume mounted
// at SITE_STATE_DIR and survives container recreation without a separate cache
// service.

const STATE_DIR = process.env.SITE_STATE_DIR || '/var/app/state/site'

type Entry = {
  value: string
  expiresAt: number | null
}

type SetOption = string | number

const keyQueues = new Map<string, Promise<unknown>>()
let dirReady: Promise<void> | undefined

// A write goes to a temporary file that is renamed over the real one. A process that dies in between leaves the
// temporary file behind; with a value of several hundred MB and a worker that was restarting every minute they had
// piled up to 30 GB. Anything this old cannot belong to a write that is still going.
const STALE_TMP_MS = 30 * 60_000

async function removeStaleTemporaryFiles(): Promise<void> {
  try {
    const now = Date.now()
    for (const name of await readdir(STATE_DIR)) {
      if (!name.endsWith('.tmp')) continue
      const path = join(STATE_DIR, name)
      const info = await stat(path).catch(() => null)
      if (info?.isFile() && now - info.mtimeMs > STALE_TMP_MS) await rm(path, { force: true }).catch(() => {})
    }
  } catch (error) {
    console.warn('[state] temporary file sweep failed:', (error as Error).message)
  }
}

function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(STATE_DIR, { recursive: true }).then(() => removeStaleTemporaryFiles())
  }
  return dirReady
}

function keyPath(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex')
  return join(STATE_DIR, `${digest}.json`)
}

async function serializeKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = keyQueues.get(key) || Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.catch(() => {}).then(() => gate)
  keyQueues.set(key, queued)

  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (keyQueues.get(key) === queued) keyQueues.delete(key)
  }
}

async function readEntry(key: string): Promise<Entry | null> {
  await ensureDir()
  const path = keyPath(key)
  try {
    const entry = JSON.parse(await readFile(path, 'utf8')) as Entry
    if (!entry || typeof entry.value !== 'string') return null
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      await rm(path, { force: true }).catch(() => {})
      return null
    }
    return entry
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

async function atomicWrite(key: string, entry: Entry): Promise<void> {
  await ensureDir()
  const path = keyPath(key)
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await open(tmp, 'wx').then(async (handle) => {
      try {
        await handle.writeFile(JSON.stringify(entry), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** The inside of a JSON string literal for `text` (what goes between the quotes). */
export function jsonStringBody(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

function parseSetOptions(options: SetOption[]): { ttlMs: number | null; nx: boolean } {
  let ttlMs: number | null = null
  let nx = false

  for (let i = 0; i < options.length; i += 1) {
    const token = String(options[i]).toUpperCase()
    if (token === 'NX') {
      nx = true
      continue
    }
    if (token === 'EX' || token === 'PX') {
      const amount = Number(options[i + 1])
      if (Number.isFinite(amount) && amount > 0) {
        ttlMs = token === 'EX' ? amount * 1000 : amount
      }
      i += 1
    }
  }

  return { ttlMs, nx }
}

export class PersistentStateStore {
  async get(key: string): Promise<string | null> {
    return (await readEntry(key))?.value ?? null
  }

  async set(key: string, value: string, ...options: SetOption[]): Promise<'OK' | null> {
    const parsed = parseSetOptions(options)
    return serializeKey(key, async () => {
      if (parsed.nx && await readEntry(key)) return null
      const expiresAt = parsed.ttlMs == null ? null : Date.now() + parsed.ttlMs
      await atomicWrite(key, {
        value: String(value),
        expiresAt,
      })
      return 'OK'
    })
  }

  /**
   * Same stored shape as set(), but the value arrives in pieces and is never held whole: the file is
   * `{"value":"<escaped pieces>","expiresAt":...}`, which readEntry() parses like any other entry.
   */
  async setStream(key: string, pieces: AsyncIterable<string>, ...options: SetOption[]): Promise<'OK'> {
    const parsed = parseSetOptions(options)
    return serializeKey(key, async () => {
      await ensureDir()
      const path = keyPath(key)
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
      const expiresAt = parsed.ttlMs == null ? null : Date.now() + parsed.ttlMs
      const handle = await open(tmp, 'wx')
      try {
        await handle.write('{"value":"')
        for await (const piece of pieces) await handle.write(jsonStringBody(piece))
        await handle.write(`","expiresAt":${expiresAt}}`)
        await handle.sync()
        await handle.close()
        await rename(tmp, path)
        return 'OK' as const
      } catch (error) {
        await handle.close().catch(() => {})
        await rm(tmp, { force: true }).catch(() => {})
        throw error
      }
    })
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0
    for (const key of keys) {
      removed += await serializeKey(key, async () => {
        const existed = Boolean(await readEntry(key))
        await rm(keyPath(key), { force: true })
        return existed ? 1 : 0
      })
    }
    return removed
  }

  async delete(...keys: string[]): Promise<number> {
    return this.del(...keys)
  }

  async exists(key: string): Promise<number> {
    return (await readEntry(key)) ? 1 : 0
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    return serializeKey(key, async () => {
      const current = await readEntry(key)
      if (!current || current.value !== expected) return false
      await rm(keyPath(key), { force: true })
      return true
    })
  }
}

let store: PersistentStateStore | undefined

export function useStateStore(): PersistentStateStore {
  if (!store) store = new PersistentStateStore()
  return store
}

export async function stateStoreReady(): Promise<boolean> {
  try {
    await ensureDir()
    return true
  } catch (error) {
    console.error('[state] persistent store unavailable:', (error as Error).message)
    return false
  }
}
