type RateLimitWindow = {
  startedAt: number
  count: number
}

type FixedWindowRateLimiterOptions = {
  limit: number
  windowMs: number
  maxEntries?: number
}

/**
 * Small process-local fixed-window limiter with bounded memory.
 *
 * This is suitable only for per-instance best-effort protection. Multi-instance
 * deployments should use a shared store at the edge or in Redis instead.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly maxEntries: number
  private nextSweepAt = 0

  constructor(options: FixedWindowRateLimiterOptions) {
    this.limit = Math.max(1, Math.floor(options.limit))
    this.windowMs = Math.max(1, Math.floor(options.windowMs))
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 5_000))
  }

  consume(key: string, now = Date.now()): boolean {
    this.sweepExpired(now)

    const current = this.windows.get(key)
    if (!current || now - current.startedAt >= this.windowMs) {
      this.ensureCapacity()
      this.windows.set(key, { startedAt: now, count: 1 })
      return true
    }

    current.count += 1
    return current.count <= this.limit
  }

  private sweepExpired(now: number) {
    if (now < this.nextSweepAt) return
    this.nextSweepAt = now + this.windowMs

    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) {
        this.windows.delete(key)
      }
    }
  }

  private ensureCapacity() {
    while (this.windows.size >= this.maxEntries) {
      const oldestKey = this.windows.keys().next().value as string | undefined
      if (!oldestKey) return
      this.windows.delete(oldestKey)
    }
  }
}
