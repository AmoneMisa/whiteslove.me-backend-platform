// Text extraction/translation provider chain. Structurally identical to
// vision.js's analyzeNow: per-provider cooldown on retryable failures, iterate
// config.textProviders until one succeeds, aggregate errors otherwise. No
// result-level cache here — extraction/translation already cache one layer up
// in src/cache/cache.js.
//
// A provider listed in PARTIAL_PROVIDERS (the self-hosted encoder) answers only
// some fields. Its answer is kept and the chain carries on, so the next
// provider fills what is still null; the partial answer wins where it has a
// value. If nothing after it succeeds, the partial answer is returned alone.
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { TEXT_PROVIDERS, PARTIAL_PROVIDERS } from './text-providers.js';
import { failureKind, textCooldownFor } from '../util/providerCooldown.js';

const cooldownUntil = new Map();

const isBlank = (value) => value == null || (Array.isArray(value) && value.length === 0);

/** `partial` values win; `rest` only supplies fields `partial` left blank. */
export function mergeCompletion(partial, rest) {
  const merged = { ...rest };
  for (const [key, value] of Object.entries(partial)) {
    if (key === 'confidence') continue;
    if (!isBlank(value)) merged[key] = value;
  }
  return merged;
}

export async function runText({ schema, systemPrompt, payload, kind, providers = config.textProviders }) {
  const errors = [];
  let partial = null;
  for (const provider of providers) {
    const run = TEXT_PROVIDERS[provider];
    if (!run) {
      errors.push(`${provider}:unsupported`);
      continue;
    }
    if ((cooldownUntil.get(provider) || 0) > Date.now()) continue;
    const started = Date.now();
    try {
      const data = await run({ schema, systemPrompt, payload, kind });
      if (PARTIAL_PROVIDERS.has(provider)) {
        partial = { provider, data, timings: { totalMs: Date.now() - started } };
        continue;
      }
      if (partial) {
        return {
          provider: `${partial.provider}+${provider}`,
          data: mergeCompletion(partial.data, data),
          timings: { totalMs: partial.timings.totalMs + Date.now() - started },
        };
      }
      return { provider, data, timings: { totalMs: Date.now() - started } };
    } catch (error) {
      const cooldownMs = textCooldownFor(error);
      if (cooldownMs > 0) {
        cooldownUntil.set(provider, Date.now() + cooldownMs);
        log.warn('text provider benched', { provider, kind: failureKind(error), cooldownMs });
      }
      errors.push(`${provider}:${error.message}`);
      log.warn('text provider failed', { provider, code: error?.code, error: error.message });
    }
  }

  if (partial) {
    log.warn('completion providers unavailable, returning partial answer', { provider: partial.provider, errors });
    return partial;
  }

  const error = new Error(`TEXT_PROVIDERS_FAILED: ${errors.join(' | ') || 'none available'}`);
  error.code = 'TEXT_PROVIDERS_FAILED';
  throw error;
}
