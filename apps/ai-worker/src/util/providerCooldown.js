import { config } from '../config.js';

/**
 * How long to bench a provider that just failed.
 *
 * A rate limit and a broken provider both fail, but they do not deserve the
 * same penalty. Mistral's limit is per-second and it produced almost every
 * vision record this deployment has; benching it for the full cooldown on a
 * 429 kept it out of the chain for nearly all of its life, so requests fell
 * through to providers that are out of credit. A provider that says when to
 * come back is taken at its word, capped so a wild Retry-After cannot bench it
 * indefinitely.
 */
export function cooldownFor(error) {
  if (error?.retryAfterMs != null) {
    return Math.min(error.retryAfterMs, config.visionCooldownMs);
  }
  return error?.status === 429 ? config.visionRateLimitCooldownMs : config.visionCooldownMs;
}
