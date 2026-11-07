// Process-local flood protection for explicit expensive actions.
// Normal read-only search requests are never rate-limited here.

export function createRateLimiter({
  now = () => Date.now(),
  maxEntries = 5000,
} = {}) {
  const buckets = new Map();
  const entryLimit = Math.max(1, Math.trunc(Number(maxEntries) || 1));

  function sweepExpired(timestamp) {
    for (const [key, expiresAt] of buckets) {
      if (expiresAt <= timestamp) buckets.delete(key);
    }
  }

  function evictOldest() {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }

  return function checkRate(req, res, bucket, windowMs) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${bucket}:${ip}`;
    const timestamp = now();
    const expiresAt = buckets.get(key) || 0;
    const wait = expiresAt - timestamp;

    if (wait > 0) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      res.status(429).json({
        error: 'Too many requests',
        retryAfterMs: wait,
      });
      return false;
    }

    if (expiresAt) buckets.delete(key);

    if (buckets.size >= entryLimit) {
      sweepExpired(timestamp);
      while (buckets.size >= entryLimit) evictOldest();
    }

    buckets.set(key, timestamp + windowMs);
    return true;
  };
}

export const checkRate = createRateLimiter();

// Sliding-window request budget per client, for ordinary read-only searches.
// The budget is deliberately generous: it exists to stop floods, not to shape
// normal use. limit <= 0 disables it.
export function createBudgetLimiter({
  now = () => Date.now(),
  maxEntries = 5000,
} = {}) {
  const windows = new Map();
  const entryLimit = Math.max(1, Math.trunc(Number(maxEntries) || 1));

  return function checkBudget(req, res, bucket, limit, windowMs) {
    if (!(limit > 0)) return true;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${bucket}:${ip}`;
    const timestamp = now();
    let entry = windows.get(key);

    if (!entry || entry.resetAt <= timestamp) {
      if (!entry && windows.size >= entryLimit) {
        for (const [k, v] of windows) if (v.resetAt <= timestamp) windows.delete(k);
        while (windows.size >= entryLimit) windows.delete(windows.keys().next().value);
      }
      entry = {count: 0, resetAt: timestamp + windowMs};
      windows.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > limit) {
      const wait = entry.resetAt - timestamp;
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      res.status(429).json({error: 'Too many requests', retryAfterMs: wait});
      return false;
    }
    return true;
  };
}

export const checkBudget = createBudgetLimiter();
