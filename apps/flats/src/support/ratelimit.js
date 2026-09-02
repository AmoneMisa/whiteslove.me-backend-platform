// Per-key rate limiter shared by scrapers so we stay a polite client and reduce
// the chance of tripping a source's anti-bot / rate rules. Each key (e.g. one per
// host) enforces a minimum interval between calls; concurrent callers reserve the
// next slot rather than all firing at once, so it serializes bursts too.
//
// Mirrors the simple lastCallAt throttle in geocode.js, generalized to N keys
// with optional random jitter (so requests don't land on an exact cadence).

const nextAllowedAt = new Map();

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait until this key's slot is free, reserving the following slot for the next
// caller. minIntervalMs is the floor between calls; jitterMs adds 0..jitter on top.
export async function throttle(key, minIntervalMs, jitterMs = 0) {
  const now = Date.now();
  const prev = nextAllowedAt.get(key) || 0;
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  const startAt = Math.max(now, prev);
  nextAllowedAt.set(key, startAt + minIntervalMs + jitter);
  const wait = startAt - now;
  if (wait > 0) await sleep(wait);
}
