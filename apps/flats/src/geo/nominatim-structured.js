import { cacheGet, cacheSet } from '../support/cache.js';
import { selectNominatimPoint } from './nominatim-client.js';

const NOMINATIM_URL = String(
  process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search',
).replace(/\/$/u, '');
const USER_AGENT = 'flat-finder/1.0 (housing aggregator; contact: admin@whiteslove.me)';
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const PUBLIC_NOMINATIM = /^https:\/\/nominatim\.openstreetmap\.org(?:\/|$)/iu.test(NOMINATIM_URL);
const MIN_INTERVAL_MS = Math.max(
  PUBLIC_NOMINATIM ? 15_500 : 250,
  Number(process.env.NOMINATIM_MIN_INTERVAL_MS) || (PUBLIC_NOMINATIM ? 15_500 : 1100),
);

let lastCallAt = 0;

function clean(value) {
  const result = String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return result || null;
}

function normalizeKey(value) {
  return clean(value)?.toLocaleLowerCase() || '-';
}

function exactAddressExpectation(input = {}) {
  return {
    kind: 'address',
    level: 'building',
    houseNumber: clean(input.houseNumber),
    building: clean(input.building),
    street: clean(input.street),
    city: clean(input.city),
  };
}

export function structuredAddressSearchParams(input = {}) {
  const street = clean(input.street);
  const houseNumber = clean(input.houseNumber);
  if (!street || !houseNumber) return null;

  const params = new URLSearchParams({
    // Nominatim's structured API expects the house number in the `street`
    // field together with the street name. Keeping city separate materially
    // reduces same-name ambiguity compared with a single free-text `q`.
    street: `${houseNumber} ${street}`,
    format: 'jsonv2',
    limit: '10',
    addressdetails: '1',
    namedetails: '1',
  });
  const city = clean(input.city);
  if (city) params.set('city', city);
  const countryCode = clean(input.countryCode)?.toLowerCase();
  if (countryCode) params.set('countrycodes', countryCode);
  return params;
}

export function structuredAddressCacheKey(input = {}) {
  return [
    'geo:structured:v1',
    normalizeKey(input.countryCode),
    normalizeKey(input.city),
    normalizeKey(input.street),
    normalizeKey(input.houseNumber),
    normalizeKey(input.building),
  ].map((part, index) => index === 0 ? part : encodeURIComponent(part)).join(':');
}

export async function cachedStructuredAddressPoint(input = {}) {
  const params = structuredAddressSearchParams(input);
  if (!params) return null;
  const cached = await cacheGet(structuredAddressCacheKey(input));
  return cached ? cached.coords : undefined;
}

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

export async function fetchStructuredAddressPoint(input = {}) {
  const params = structuredAddressSearchParams(input);
  if (!params) return null;
  const key = structuredAddressCacheKey(input);
  const expectation = exactAddressExpectation(input);

  await throttle();
  try {
    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en,ru,uk,uz,kk,ro',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`nominatim ${response.status}`);
    const data = await response.json();
    const coords = selectNominatimPoint(data, expectation, input.countryCode || null);
    await cacheSet(key, { coords }, coords ? HIT_TTL_MS : MISS_TTL_MS);

    // Free-text fallback uses the same provider. Leave a complete public-policy
    // interval so sequential structured -> free-text calls cannot burst.
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS));
    return coords;
  } catch {
    await cacheSet(key, { coords: null }, ERROR_TTL_MS);
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS));
    return null;
  }
}

export async function geocodeStructuredAddress(input = {}) {
  const cached = await cachedStructuredAddressPoint(input);
  return cached === undefined ? fetchStructuredAddressPoint(input) : cached;
}
