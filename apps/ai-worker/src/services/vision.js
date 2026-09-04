import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { memoryGet, memorySet } from '../cache/memory.js';
import { log } from '../util/logger.js';
import { VISION_PROVIDERS } from './vision-providers.js';

const cooldownUntil = new Map();
const CACHE_PREFIX = 'ai:vision:';
let active = 0;
const waiters = [];

async function acquire() {
  if (active < config.visionConcurrency) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active = Math.max(0, active - 1);
  waiters.shift()?.();
}

function cacheKey(images) {
  const hash = createHash('sha256');
  hash.update(`vision:v${config.promptVersion}:s${config.schemaVersion}\n`);
  for (const image of images) hash.update(`${image}\n`);
  return hash.digest('hex').slice(0, 40);
}

export function normalizeImages(images) {
  return images.slice(0, config.maxPhotosPerListing).map((image, index) => {
    if (typeof image === 'string') return { id: `photo_${index + 1}`, url: image };
    return {
      id: String(image?.id || `photo_${index + 1}`),
      url: String(image?.url || image?.dataUrl || ''),
    };
  }).filter((image) => /^https?:\/\//i.test(image.url) || /^data:image\//i.test(image.url));
}

/**
 * How long to bench a provider that just failed.
 *
 * A rate limit and a broken provider both fail, but they do not deserve the
 * same penalty. Mistral's limit is per-second and it produced almost every
 * vision record we have; benching it for five minutes on a 429 kept it out of
 * the chain for nearly all of its life, so the whole chain fell through to
 * providers that are out of credit. A provider that says when to come back is
 * taken at its word.
 */
function cooldownFor(error) {
  if (error?.retryAfterMs != null) {
    return Math.min(error.retryAfterMs, config.visionCooldownMs);
  }
  return error?.status === 429 ? config.visionRateLimitCooldownMs : config.visionCooldownMs;
}

async function analyzeNow(inputImages) {
  const images = normalizeImages(Array.isArray(inputImages) ? inputImages : []);
  if (!images.length) {
    const error = new Error('VISION_NO_VALID_IMAGES');
    error.code = 'VISION_NO_VALID_IMAGES';
    throw error;
  }

  const key = cacheKey(images.map((image) => `${image.id}:${image.url}`));
  const cached = memoryGet(CACHE_PREFIX + key);
  if (cached) return { cached: true, ...cached };

  const errors = [];
  for (const provider of config.visionProviders) {
    const run = VISION_PROVIDERS[provider];
    if (!run) {
      errors.push(`${provider}:unsupported`);
      continue;
    }
    if ((cooldownUntil.get(provider) || 0) > Date.now()) continue;
    try {
      const data = await run(images);
      const record = { provider, data, analyzedAt: new Date().toISOString() };
      memorySet(CACHE_PREFIX + key, record, config.visionCacheTtlMs);
      return { cached: false, ...record };
    } catch (error) {
      if (error?.retryable) cooldownUntil.set(provider, Date.now() + cooldownFor(error));
      errors.push(`${provider}:${error.message}`);
      log.warn('vision provider failed', { provider, code: error?.code, error: error.message });
    }
  }

  const error = new Error(`VISION_PROVIDERS_FAILED: ${errors.join(' | ') || 'none available'}`);
  error.code = 'VISION_PROVIDERS_FAILED';
  throw error;
}

export async function analyzePhotos(inputImages) {
  await acquire();
  try {
    return await analyzeNow(inputImages);
  } finally {
    release();
  }
}
