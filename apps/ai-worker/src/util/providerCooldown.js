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

// A 400/422 whose body says the account or model is the problem. A 400 about
// the request itself (a schema it rejects, malformed input) says nothing about
// the provider and must not bench it.
const BROKEN_BODY = /model|not found|does not exist|unavailable|credit|quota|billing|balance|deprecated|access/i;
const REQUEST_BODY = /response_format|json_schema|structured|schema/i;
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * What a failed text-provider call says about the provider itself.
 *
 *  rate_limited  429: back off briefly, the provider says when to return.
 *  unavailable   5xx or timeout: transient, the standard cooldown.
 *  network       no HTTP answer at all (DNS, refused, region block): transient.
 *  broken        401/402/403/404 or a 400 naming the model/account: persistent.
 *  request       anything about this one request (bad JSON, schema): the
 *                provider is fine, so it is not benched.
 */
export function failureKind(error) {
  const status = error?.status;
  if (status === 429) return 'rate_limited';
  if (status >= 500 || error?.code === 'PROVIDER_TIMEOUT') return 'unavailable';
  if (status === 401 || status === 402 || status === 403 || status === 404) return 'broken';
  if (status === 400 || status === 422) {
    const message = String(error?.message || '');
    return BROKEN_BODY.test(message) && !REQUEST_BODY.test(message) ? 'broken' : 'request';
  }
  if (status == null) {
    const cause = error?.cause;
    if (NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(cause?.code)) return 'network';
    if (error instanceof TypeError && /fetch failed/i.test(error.message || '')) return 'network';
  }
  return 'request';
}

/** Cooldown in ms for a failed text-provider call, 0 when it must not be benched. */
export function textCooldownFor(error) {
  switch (failureKind(error)) {
    case 'rate_limited':
      return cooldownFor(error);
    case 'unavailable':
    case 'network':
      return config.visionCooldownMs;
    case 'broken':
      return config.textBrokenCooldownMs;
    default:
      return 0;
  }
}
