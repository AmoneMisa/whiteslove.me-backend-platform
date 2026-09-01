type CacheEntry<V> = {
  value: V
  expiresAt: number
}

type BoundedTtlCacheOptions = {
  maxEntries: number
  defaultTtlMs: number
}

/**
 * Small process-local TTL cache with LRU eviction and bounded memory.
 *
 * Reading an entry refreshes its LRU position, not its expiry deadline. This
 * keeps the cache useful for hot keys without allowing a stale value to live
 * forever just because it is read frequently.
 */
export class BoundedTtlCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>()
  private readonly maxEntries: number
  private readonly defaultTtlMs: number

  constructor(options: BoundedTtlCacheOptions) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries))
    this.defaultTtlMs = Math.max(1, Math.floor(options.defaultTtlMs))
  }

  get(key: K, now = Date.now()): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return undefined
    }

    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  peek(key: K, now = Date.now()): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs, now = Date.now()): void {
    const expiresAt = now + Math.max(1, Math.floor(ttlMs))
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt })
    this.evictOverflow()
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  values(now = Date.now()): V[] {
    this.sweepExpired(now)
    return [...this.entries.values()].map((entry) => entry.value)
  }

  get size(): number {
    return this.entries.size
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as K | undefined
      if (oldestKey === undefined) return
      this.entries.delete(oldestKey)
    }
  }
}
