// Foreign-exchange rates from a free, key-less public API, cached in memory.
//
// Rates are expressed relative to USD (units of currency per 1 USD) — the same
// shape the Flutter app uses to convert a listing's native price into the
// display currency chosen in Settings:
//   amountInTarget = amount * rates[target] / rates[source]
//
// If the live API is unreachable we fall back to a static approximate table so
// the endpoint never fails; the next successful call refreshes the cache.

const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Approximate fallback rates (units per 1 USD). Only used until a live fetch
// succeeds. Covers the currencies this project deals with.
const FALLBACK = { USD: 1, EUR: 0.92, RON: 4.57, UAH: 41.5, KZT: 470, UZS: 12600 };

const RETRY_MS = 60_000;
let cache = { at: 0, base: 'USD', rates: {...FALLBACK} };
let nextRefreshAt = 0;
let refreshPromise = null;

// Convert an amount in `currency` to USD using rates (units per 1 USD).
// Returns null when the amount is missing or the currency has no known rate.
export function toUsd(amount, currency, rates) {
  if (amount == null) return null;
  const r = rates?.[String(currency || 'USD').toUpperCase()];
  return r ? amount / r : null;
}

export async function getRates() {
  const hadLiveCache = cache.at > 0;
  if (!refreshPromise && Date.now() >= nextRefreshAt) {
    nextRefreshAt = Date.now() + RETRY_MS;
    refreshPromise = refreshRates().finally(() => { refreshPromise = null; });
  }
  // The first request benefits from live rates when the provider is available;
  // subsequent requests keep serving the last known table while a refresh runs.
  if (!hadLiveCache && refreshPromise) {
    await refreshPromise;
  }
  return cache;
}

async function refreshRates() {
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`fx HTTP ${res.status}`);
    const json = await res.json();
    if (json.result !== 'success' || json.base_code !== 'USD' || json.rates?.USD !== 1
      || !Object.values(json.rates).every(rate => Number.isFinite(rate) && rate > 0)) {
      throw new Error('fx unexpected payload');
    }
    cache = { at: Date.now(), base: json.base_code ?? 'USD', rates: json.rates };
    nextRefreshAt = Date.now() + TTL_MS;
  } catch (err) {
    console.warn(`[fx] live rates unavailable, using fallback: ${err.message}`);
    // Keep a stale-but-real cache if we already have one; otherwise seed the
    // fallback so callers always get a usable table.
    nextRefreshAt = Date.now() + RETRY_MS;
  }
  return cache;
}
