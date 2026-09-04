// Shared HTTP wrapper for external LLM providers (vision + text). Handles the
// timeout/abort/retryable-status/metrics bookkeeping so vision-providers.js
// and text-providers.js don't duplicate it.
import { config } from '../config.js';
import { recordProviderResult } from './metrics.js';

/**
 * A Retry-After header in milliseconds, or null when absent or unparseable.
 *
 * The header comes as either a number of seconds or an HTTP date; both forms
 * are in use across these providers.
 */
export function retryAfterMs(headerValue) {
  if (!headerValue) return null;
  const raw = String(headerValue).trim();

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : 0;

  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

export async function fetchJson(url, options, provider, { bucket = 'visionProviders', timeoutMs } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || config.visionProviderTimeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: ctrl.signal });
    const ms = Date.now() - started;
    if (!response.ok) {
      recordProviderResult(bucket, provider, { ok: false, ms, status: response.status });
      const body = await response.text().catch(() => '');
      const error = new Error(`${provider.toUpperCase()}_HTTP_${response.status}: ${body.slice(0, 200)}`);
      error.status = response.status;
      error.retryable = response.status === 429 || response.status >= 500;
      error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
      throw error;
    }
    recordProviderResult(bucket, provider, { ok: true, ms });
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      recordProviderResult(bucket, provider, { ok: false, ms: Date.now() - started, timeout: true });
      const timeout = new Error(`${provider.toUpperCase()}_TIMEOUT`);
      timeout.code = 'PROVIDER_TIMEOUT';
      timeout.retryable = true;
      throw timeout;
    }
    if (!error?.status) recordProviderResult(bucket, provider, { ok: false, ms: Date.now() - started });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first balanced JSON object in `text`, or null.
 *
 * Braces inside strings are skipped, so a value like "a {kitchen}" does not
 * end the object early.
 */
function embeddedJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseModelJson(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch (error) {
    // Smaller models introduce the answer before giving it: "Based on the
    // provided image, here is the JSON object:" followed by the object. The
    // JSON is intact, so throwing away a usable answer over its preamble is
    // pure loss.
    const embedded = embeddedJsonObject(text);
    if (embedded === null) throw error;
    return JSON.parse(embedded);
  }
}
