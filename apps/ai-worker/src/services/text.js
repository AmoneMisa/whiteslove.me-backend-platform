// Text extraction/translation provider chain. Structurally identical to
// vision.js's analyzeNow: per-provider cooldown on retryable failures, iterate
// config.textProviders until one succeeds, aggregate errors otherwise. No
// result-level cache here — extraction/translation already cache one layer up
// in src/cache/cache.js.
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { TEXT_PROVIDERS } from './text-providers.js';
import { failureKind, textCooldownFor } from '../util/providerCooldown.js';

const cooldownUntil = new Map();

export async function runText({ schema, systemPrompt, payload, kind, providers = config.textProviders }) {
  const errors = [];
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

  const error = new Error(`TEXT_PROVIDERS_FAILED: ${errors.join(' | ') || 'none available'}`);
  error.code = 'TEXT_PROVIDERS_FAILED';
  throw error;
}
