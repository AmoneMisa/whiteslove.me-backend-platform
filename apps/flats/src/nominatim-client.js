import { cacheGet, cacheSet } from './cache.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'flat-finder/1.0 (housing aggregator; contact: admin@whiteslove.me)';
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const MIN_INTERVAL_MS = 1100;

let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

export function nominatimCacheKey(query, countryCode) {
  const country = countryCode ? `${countryCode.toLowerCase()}:` : '';
  return `geo:v3:${country}${query.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

export async function cachedNominatimPoint(query, countryCode) {
  const cached = await cacheGet(nominatimCacheKey(query, countryCode));
  return cached ? cached.coords : undefined;
}

export async function fetchNominatimPoint(query, countryCode) {
  await throttle();
  try {
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1' });
    if (countryCode) params.set('countrycodes', countryCode.toLowerCase());
    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`nominatim ${response.status}`);
    const data = await response.json();
    const first = Array.isArray(data) ? data[0] : null;
    const coords = first ? { lat: Number(first.lat), lng: Number(first.lon) } : null;
    await cacheSet(nominatimCacheKey(query, countryCode), { coords }, coords ? HIT_TTL_MS : MISS_TTL_MS);
    return coords;
  } catch {
    await cacheSet(nominatimCacheKey(query, countryCode), { coords: null }, ERROR_TTL_MS);
    return null;
  }
}

export async function geocodeQuery(query, countryCode) {
  if (!query) return null;
  const cached = await cachedNominatimPoint(query, countryCode);
  return cached === undefined ? fetchNominatimPoint(query, countryCode) : cached;
}

export async function geocodeBbox(query) {
  if (!query) return null;
  const key = `geo:bbox:v1:${query.toLowerCase().trim()}`;
  const cached = await cacheGet(key);
  if (cached) return cached.bbox;

  await throttle();
  try {
    const params = new URLSearchParams({ q: query, format: 'json', limit: '1' });
    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`nominatim ${response.status}`);
    const data = await response.json();
    const raw = Array.isArray(data) ? data[0]?.boundingbox : null;
    const numbers = (raw || []).map(Number);
    const bbox = numbers.length === 4 && numbers.every(Number.isFinite)
      ? [numbers[0], numbers[2], numbers[1], numbers[3]]
      : null;
    await cacheSet(key, { bbox }, bbox ? HIT_TTL_MS : MISS_TTL_MS);
    return bbox;
  } catch {
    await cacheSet(key, { bbox: null }, ERROR_TTL_MS);
    return null;
  }
}
