// Per-channel Telegram crawl cursors.
//
// Without them every refresh re-read a channel's whole configured history —
// up to 5,000 messages, 25 sequential pages — through a worker that answers one
// request at a time. Large low-yield channels monopolised the queue and the
// rest timed out waiting.
//
// Two directions are tracked per channel, because they answer different
// questions:
//   newestMessageId — where incremental polling resumes; everything above it is
//                     new and worth reading on every refresh.
//   oldestMessageId — how far the historical backfill has reached; it walks
//                     down once, in bounded pages, and then stops for good.
//
// Incremental polling never waits for the backfill to finish: a channel being
// backfilled still reports its new posts on the normal cadence.
//
// Retention (three months) is enforced on the stored candidates, not by
// re-fetching three months of Telegram history each time.

import { Pool } from 'pg'

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/i

export interface ChannelCursor {
  handle: string
  newestMessageId: number
  oldestMessageId: number
  bootstrapComplete: boolean
  lastMessageDate: string | null
  lastSuccessAt: string | null
}

export function emptyCursor(handle: string): ChannelCursor {
  return {
    handle,
    newestMessageId: 0,
    oldestMessageId: 0,
    bootstrapComplete: false,
    lastMessageDate: null,
    lastSuccessAt: null,
  }
}

export interface WebCursor {
  sourceKey: string
  lastSeenProfileId: string
  lastSeenUrl: string
  lastSeenUpdatedAt: string | null
  backfillPage: number
  bootstrapComplete: boolean
  lastSuccessAt: string | null
}

export function emptyWebCursor(sourceKey: string): WebCursor {
  return {
    sourceKey,
    lastSeenProfileId: '',
    lastSeenUrl: '',
    lastSeenUpdatedAt: null,
    backfillPage: 1,
    bootstrapComplete: false,
    lastSuccessAt: null,
  }
}

const memory = new Map<string, ChannelCursor>()
const webMemory = new Map<string, WebCursor>()

let pool: Pool | undefined
let ready: Promise<void> | undefined

function schema(): string {
  const raw = (process.env.HIRING_DB_SCHEMA || 'hiring').trim()
  return SCHEMA_RE.test(raw) ? raw : 'hiring'
}

function enabled(): boolean {
  return Boolean((process.env.HIRING_DATABASE_URL || '').trim())
}

function db(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.HIRING_DATABASE_URL,
      max: Number(process.env.HIRING_DB_POOL_MAX) || 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    pool.on('error', (error) => console.error('[hiring:cursors] idle client error:', error.message))
  }
  return pool
}

function ensureSchema(): Promise<void> {
  if (ready) return ready
  const name = schema()
  ready = (async () => {
    await db().query(`CREATE SCHEMA IF NOT EXISTS ${name};`)
    await db().query(`
      CREATE TABLE IF NOT EXISTS ${name}.channel_cursors (
        handle TEXT PRIMARY KEY,
        newest_message_id BIGINT NOT NULL DEFAULT 0,
        oldest_message_id BIGINT NOT NULL DEFAULT 0,
        bootstrap_complete BOOLEAN NOT NULL DEFAULT FALSE,
        last_message_date TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await db().query(`
      CREATE TABLE IF NOT EXISTS ${name}.web_cursors (
        source_key TEXT PRIMARY KEY,
        last_seen_profile_id TEXT NOT NULL DEFAULT '',
        last_seen_url TEXT NOT NULL DEFAULT '',
        last_seen_updated_at TIMESTAMPTZ,
        backfill_page INTEGER NOT NULL DEFAULT 1,
        bootstrap_complete BOOLEAN NOT NULL DEFAULT FALSE,
        last_success_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    await db().query(`ALTER TABLE ${name}.web_cursors ADD COLUMN IF NOT EXISTS backfill_page INTEGER NOT NULL DEFAULT 1;`)
    await db().query(`ALTER TABLE ${name}.web_cursors ADD COLUMN IF NOT EXISTS bootstrap_complete BOOLEAN NOT NULL DEFAULT FALSE;`)
    console.log(`[hiring:cursors] schema ${name} ready`)
  })().catch((error) => {
    ready = undefined
    throw error
  })
  return ready
}

function fromRow(row: Record<string, unknown>): ChannelCursor {
  return {
    handle: String(row.handle),
    newestMessageId: Number(row.newest_message_id) || 0,
    oldestMessageId: Number(row.oldest_message_id) || 0,
    bootstrapComplete: row.bootstrap_complete === true,
    lastMessageDate: row.last_message_date ? new Date(row.last_message_date as string).toISOString() : null,
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at as string).toISOString() : null,
  }
}

export async function loadCursors(): Promise<Map<string, ChannelCursor>> {
  if (!enabled()) return new Map(memory)
  try {
    await ensureSchema()
    const result = await db().query(`SELECT * FROM ${schema()}.channel_cursors;`)
    const cursors = new Map<string, ChannelCursor>()
    for (const row of result.rows) cursors.set(String(row.handle), fromRow(row))
    return cursors
  } catch (error) {
    console.warn('[hiring:cursors] load failed:', (error as Error).message)
    return new Map(memory)
  }
}

export async function saveCursor(next: ChannelCursor): Promise<void> {
  const previous = memory.get(next.handle) || emptyCursor(next.handle)
  const merged: ChannelCursor = {
    handle: next.handle,
    newestMessageId: Math.max(previous.newestMessageId, next.newestMessageId),
    oldestMessageId: previous.oldestMessageId === 0
      ? next.oldestMessageId
      : Math.min(previous.oldestMessageId || Number.MAX_SAFE_INTEGER, next.oldestMessageId || Number.MAX_SAFE_INTEGER),
    bootstrapComplete: next.bootstrapComplete || previous.bootstrapComplete,
    lastMessageDate: next.lastMessageDate || previous.lastMessageDate,
    lastSuccessAt: next.lastSuccessAt || new Date().toISOString(),
  }
  memory.set(merged.handle, merged)

  if (!enabled()) return
  try {
    await ensureSchema()
    await db().query(
      `INSERT INTO ${schema()}.channel_cursors (
         handle, newest_message_id, oldest_message_id, bootstrap_complete,
         last_message_date, last_success_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, NOW())
       ON CONFLICT (handle) DO UPDATE SET
         newest_message_id = GREATEST(${schema()}.channel_cursors.newest_message_id, EXCLUDED.newest_message_id),
         oldest_message_id = CASE
           WHEN ${schema()}.channel_cursors.oldest_message_id = 0 THEN EXCLUDED.oldest_message_id
           WHEN EXCLUDED.oldest_message_id = 0 THEN ${schema()}.channel_cursors.oldest_message_id
           ELSE LEAST(${schema()}.channel_cursors.oldest_message_id, EXCLUDED.oldest_message_id)
         END,
         bootstrap_complete = ${schema()}.channel_cursors.bootstrap_complete OR EXCLUDED.bootstrap_complete,
         last_message_date = COALESCE(EXCLUDED.last_message_date, ${schema()}.channel_cursors.last_message_date),
         last_success_at = COALESCE(EXCLUDED.last_success_at, ${schema()}.channel_cursors.last_success_at),
         updated_at = NOW();`,
      [
        merged.handle,
        merged.newestMessageId,
        merged.oldestMessageId,
        merged.bootstrapComplete,
        merged.lastMessageDate,
        merged.lastSuccessAt,
      ],
    )
  } catch (error) {
    console.warn(`[hiring:cursors] save @${next.handle} failed:`, (error as Error).message)
  }
}

export async function loadWebCursors(): Promise<Map<string, WebCursor>> {
  if (!enabled()) return new Map(webMemory)
  try {
    await ensureSchema()
    const result = await db().query(`SELECT * FROM ${schema()}.web_cursors;`)
    const cursors = new Map<string, WebCursor>()
    for (const row of result.rows) {
      cursors.set(String(row.source_key), {
        sourceKey: String(row.source_key),
        lastSeenProfileId: String(row.last_seen_profile_id || ''),
        lastSeenUrl: String(row.last_seen_url || ''),
        lastSeenUpdatedAt: row.last_seen_updated_at ? new Date(row.last_seen_updated_at).toISOString() : null,
        backfillPage: Math.max(1, Number(row.backfill_page) || 1),
        bootstrapComplete: row.bootstrap_complete === true,
        lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      })
    }
    return cursors
  } catch (error) {
    console.warn('[hiring:cursors] web load failed:', (error as Error).message)
    return new Map(webMemory)
  }
}

export async function saveWebCursor(next: WebCursor): Promise<void> {
  webMemory.set(next.sourceKey, { ...next, lastSuccessAt: next.lastSuccessAt || new Date().toISOString() })
  if (!enabled()) return
  try {
    await ensureSchema()
    await db().query(
      `INSERT INTO ${schema()}.web_cursors (
         source_key, last_seen_profile_id, last_seen_url, last_seen_updated_at,
         backfill_page, bootstrap_complete, last_success_at, updated_at
       ) VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7::timestamptz, NOW())
       ON CONFLICT (source_key) DO UPDATE SET
         last_seen_profile_id = EXCLUDED.last_seen_profile_id,
         last_seen_url = EXCLUDED.last_seen_url,
         last_seen_updated_at = EXCLUDED.last_seen_updated_at,
         backfill_page = GREATEST(${schema()}.web_cursors.backfill_page, EXCLUDED.backfill_page),
         bootstrap_complete = ${schema()}.web_cursors.bootstrap_complete OR EXCLUDED.bootstrap_complete,
         last_success_at = COALESCE(EXCLUDED.last_success_at, ${schema()}.web_cursors.last_success_at),
         updated_at = NOW();`,
      [
        next.sourceKey,
        next.lastSeenProfileId,
        next.lastSeenUrl,
        next.lastSeenUpdatedAt,
        Math.max(1, next.backfillPage || 1),
        next.bootstrapComplete === true,
        next.lastSuccessAt || new Date().toISOString(),
      ],
    )
  } catch (error) {
    console.warn(`[hiring:cursors] web save ${next.sourceKey} failed:`, (error as Error).message)
  }
}
