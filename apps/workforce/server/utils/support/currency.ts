// Live currency → USD rates for salary normalization + display.
//
// Rates come from fawazahmed0/currency-api (the same source used by the Android
// Rustic Price Converter), with jsDelivr npm, GitHub raw and Staticaly fallbacks.
// They are cached in the persistent state store (24h) and mirrored in memory so
// the hot path (enrich.ts, called per job per request) stays synchronous. Every
// value is stored as USD-per-1-unit (e.g. UAH -> ~0.024), so `amount * rate = USD`.
//
// The static table below is only a FALLBACK for a cold cache or an API outage —
// the live fetch overwrites it.

import { useStateStore } from '~~/server/utils/support/stateStore'

const FALLBACK_USD_RATES: Record<string, number> = {
  USD: 1, EUR: 1.09, GBP: 1.27, PLN: 0.25, UAH: 0.024, KZT: 0.0019,
  UZS: 0.000079, AZN: 0.59, GEL: 0.37, AMD: 0.0026, KGS: 0.011, MDL: 0.056,
  TJS: 0.092, TMT: 0.286, TRY: 0.030, CAD: 0.73, CHF: 1.12, INR: 0.012,
  CNY: 0.14, JPY: 0.0064, KRW: 0.00072,
}

const RATES_KEY = 'jobs:fx:usd-rates:v2'
const RATES_TTL_SECONDS = 24 * 3600
const FX_TIMEOUT_MS = 8_000
const FX_API_URLS = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://raw.githubusercontent.com/fawazahmed0/exchange-api/main/v1/latest/currencies/usd.json',
  'https://cdn.staticaly.com/gh/fawazahmed0/exchange-api@latest/v1/latest/currencies/usd.json',
]
const EXCLUDED_CURRENCIES = new Set(['BYN'])

// In-memory cache (USD-per-unit). Seeded with the fallback so toUsd() works even
// before the first load; overwritten by loadRates()/refreshRates().
let memRates: Record<string, number> = { ...FALLBACK_USD_RATES }
let memLoaded = false

// The USD document returns UNITS-per-USD. Invert to USD-per-unit.
function invertToUsdPerUnit(unitsPerUsd: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [code, r] of Object.entries(unitsPerUsd)) {
    const normalized = code.toUpperCase()
    if (!EXCLUDED_CURRENCIES.has(normalized) && typeof r === 'number' && r > 0) {
      out[normalized] = 1 / r
    }
  }
  out.USD = 1
  return out
}

async function fetchUnitsPerUsd(): Promise<Record<string, number>> {
  const failures: string[] = []
  for (const url of FX_API_URLS) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FX_TIMEOUT_MS),
      })
      if (!res.ok) {
        failures.push(`${new URL(url).host}: ${res.status}`)
        continue
      }
      const data = (await res.json()) as {
        date?: string
        usd?: Record<string, number>
        USD?: Record<string, number>
      }
      const rates = data.usd || data.USD
      if (!rates || typeof rates !== 'object' || Object.keys(rates).length < 10) {
        failures.push(`${new URL(url).host}: bad payload`)
        continue
      }
      return rates
    } catch (err) {
      failures.push(`${new URL(url).host}: ${(err as Error).name || 'request failed'}`)
    }
  }
  throw new Error(failures.join('; ') || 'all providers failed')
}

function sanitizeUsdPerUnit(rates: unknown): Record<string, number> {
  if (!rates || typeof rates !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [code, rate] of Object.entries(rates as Record<string, unknown>)) {
    const normalized = code.toUpperCase()
    if (
      /^[A-Z]{3}$/.test(normalized)
      && !EXCLUDED_CURRENCIES.has(normalized)
      && typeof rate === 'number'
      && Number.isFinite(rate)
      && rate > 0
    ) {
      out[normalized] = rate
    }
  }
  return out
}

/** Current USD-per-unit rate table (live if loaded, else the static fallback). */
export function getRates(): Record<string, number> {
  return memRates
}

/** Convert an amount in `currency` to whole USD, or undefined if unknown/invalid. */
export function toUsd(amount: number | undefined, currency: string | undefined): number | undefined {
  if (!amount || amount <= 0 || !currency) return undefined
  const rate = memRates[currency.toUpperCase()]
  if (!rate) return undefined
  return Math.round(amount * rate)
}

/** Convert between any two currencies available in the shared live FX table. */
export function convertCurrency(
  amount: number | null | undefined,
  fromCurrency: string | null | undefined,
  toCurrency: string | null | undefined,
): number | undefined {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return undefined
  const from = (fromCurrency || '').toUpperCase()
  const to = (toCurrency || '').toUpperCase()
  if (!from || !to) return undefined
  if (from === to) return Math.round(amount)
  const fromRate = memRates[from]
  const toRate = memRates[to]
  if (!fromRate || !toRate) return undefined
  return Math.round((amount * fromRate) / toRate)
}

/**
 * Populate memory from the shared persistent cache. If the cache is missing or
 * was written by an older build that omitted a required currency (notably RUB),
 * refresh it from the live API once instead of inventing a local rate.
 */
export async function loadRates(): Promise<void> {
  if (memLoaded) return
  try {
    const raw = await useStateStore().get(RATES_KEY)
    if (raw) {
      memRates = { ...FALLBACK_USD_RATES, ...sanitizeUsdPerUnit(JSON.parse(raw)) }
      memLoaded = true
      if (memRates.RUB) return
    }
  } catch {
    /* Persistent cache unavailable — try the live provider below. */
  }

  await refreshRates()
  // Avoid hitting external providers on every request during an outage. The
  // scheduled jobs refresh will retry later; until then existing fallback rates
  // remain available for currencies that have one.
  if (!memLoaded) memLoaded = true
}

/**
 * Fetch live rates from the API, then persist to the state store + memory. Called
 * by the daily refresh worker and the cold-start warmup. Never throws — on
 * failure the previous (or fallback) table stays in use.
 */
export async function refreshRates(): Promise<void> {
  try {
    const usdPerUnit = invertToUsdPerUnit(await fetchUnitsPerUsd())
    if (Object.keys(usdPerUnit).length < 10) throw new Error('fx bad normalized payload')
    memRates = { ...FALLBACK_USD_RATES, ...usdPerUnit }
    memLoaded = true
    try {
      await useStateStore().set(RATES_KEY, JSON.stringify(usdPerUnit), 'EX', RATES_TTL_SECONDS)
    } catch {
      /* best-effort persist */
    }
  } catch (err) {
    console.error('[jobs] fx refresh failed:', (err as Error).message)
  }
}
