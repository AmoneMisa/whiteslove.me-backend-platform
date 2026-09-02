// Small process-local TTL/LRU cache shared by enrichment helpers such as
// geocoding, reverse geocoding, metro lookup and vision enrichment.

export function createMemoryCache({
  now = () => Date.now(),
  maxEntries = Number(process.env.RUNTIME_CACHE_MAX_ENTRIES) || 500,
} = {}) {
  const mem = new Map(); // key -> { entry, expiresAt }

  function sweepExpired(timestamp) {
    for (const [key, hit] of mem) {
      if (hit.expiresAt != null && timestamp >= hit.expiresAt) {
        mem.delete(key);
      }
    }
  }

  function evictOldest() {
    const oldest = mem.keys().next();
    if (!oldest.done) mem.delete(oldest.value);
  }

  function get(key) {
    const normalizedKey = String(key);
    const hit = mem.get(normalizedKey);
    if (!hit) return null;

    if (hit.expiresAt != null && now() >= hit.expiresAt) {
      mem.delete(normalizedKey);
      return null;
    }

    // Refresh insertion order so frequently used entries are evicted last.
    mem.delete(normalizedKey);
    mem.set(normalizedKey, hit);
    return hit.entry;
  }

  function set(key, entry, ttlMs) {
    const timestamp = now();
    const normalizedKey = String(key);
    const ttl = Number(ttlMs);

    mem.delete(normalizedKey);
    sweepExpired(timestamp);

    while (mem.size >= Math.max(1, maxEntries)) {
      evictOldest();
    }

    mem.set(normalizedKey, {
      entry,
      expiresAt: Number.isFinite(ttl) && ttl > 0 ? timestamp + ttl : null,
    });
  }

  return {get, set};
}

const cache = createMemoryCache();

export async function cacheGet(key) {
  return cache.get(key);
}

export async function cacheSet(key, entry, ttlMs) {
  cache.set(key, entry, ttlMs);
}

export function cacheBackend() {
  return 'memory';
}
