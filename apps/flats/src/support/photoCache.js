// On-disk cache for Telegram listing photos.
//
// A photo for a given post never changes, but fetching one is expensive: it
// walks backend -> MTProto worker -> Telegram. Without a cache every cold
// request repeats that chain, which is slow for the app and slow enough to
// break social-preview crawlers (they abandon an image fetch after a few
// seconds). Photos are therefore written once and served from disk afterwards.
//
// The SSD on this host is small, so the cache is bounded: writes are rejected
// once the directory exceeds PHOTO_CACHE_MAX_MB, after evicting the
// least-recently-used entries. All failures are non-fatal — the caller simply
// falls back to fetching from the worker.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = process.env.PHOTO_CACHE_DIR || '/tmp/flat-finder-photos';
const MAX_BYTES = (Number(process.env.PHOTO_CACHE_MAX_MB) || 512) * 1024 * 1024;
const ENABLED = process.env.PHOTO_CACHE_ENABLED !== 'false';
// Guard against a single oversized response filling the cache.
const MAX_ENTRY_BYTES = (Number(process.env.PHOTO_CACHE_MAX_ENTRY_KB) || 4096) * 1024;

let ready = null;

async function ensureDir() {
  if (!ready) ready = fs.mkdir(DIR, { recursive: true }).catch(() => {});
  return ready;
}

// Flat filenames (no nested dirs) keyed by a hash of channel+id, so a hostile
// channel/id can never escape the cache directory.
function entryPath(channel, id) {
  const key = createHash('sha1').update(`${channel}/${id}`).digest('hex');
  return path.join(DIR, `${key}.bin`);
}

// Content type is stored alongside the bytes in a tiny sidecar file.
function metaPath(file) {
  return `${file}.type`;
}

export async function readPhoto(channel, id) {
  if (!ENABLED) return null;
  const file = entryPath(channel, id);
  try {
    const [buf, type] = await Promise.all([
      fs.readFile(file),
      fs.readFile(metaPath(file), 'utf8').catch(() => 'image/jpeg'),
    ]);
    // Touch atime/mtime so LRU eviction keeps the photos people actually view.
    const now = new Date();
    fs.utimes(file, now, now).catch(() => {});
    return { buffer: buf, contentType: type || 'image/jpeg' };
  } catch {
    return null;
  }
}

export async function writePhoto(channel, id, buffer, contentType) {
  if (!ENABLED || !buffer?.length || buffer.length > MAX_ENTRY_BYTES) return;
  try {
    await ensureDir();
    await evictIfNeeded(buffer.length);
    const file = entryPath(channel, id);
    // Write to a temp file then rename, so a concurrent reader never sees a
    // half-written image.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, file);
    await fs.writeFile(metaPath(file), contentType || 'image/jpeg').catch(() => {});
  } catch {
    // Disk full / permission problem: caching is best-effort.
  }
}

async function evictIfNeeded(incoming) {
  try {
    const names = await fs.readdir(DIR);
    const entries = [];
    let total = 0;
    for (const name of names) {
      if (name.endsWith('.type') || name.endsWith('.tmp')) continue;
      const full = path.join(DIR, name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      total += stat.size;
      entries.push({ full, size: stat.size, at: stat.mtimeMs });
    }
    if (total + incoming <= MAX_BYTES) return;
    // Drop the oldest first until we are back under 90% of the budget, so we
    // don't evict on every single write once the cache is warm.
    entries.sort((a, b) => a.at - b.at);
    const target = MAX_BYTES * 0.9;
    for (const entry of entries) {
      if (total + incoming <= target) break;
      await fs.rm(entry.full, { force: true }).catch(() => {});
      await fs.rm(metaPath(entry.full), { force: true }).catch(() => {});
      total -= entry.size;
    }
  } catch {
    // Unreadable cache dir: skip eviction rather than failing the request.
  }
}
