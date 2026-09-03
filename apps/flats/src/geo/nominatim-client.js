import { cacheGet, cacheSet } from '../support/cache.js';
import { canonicalCityName } from './countries.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'flat-finder/1.0 (housing aggregator; contact: admin@whiteslove.me)';
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const MIN_INTERVAL_MS = 1100;

const STREET_KEYS = Object.freeze([
  'road', 'pedestrian', 'residential', 'living_street', 'footway',
  'street', 'path',
]);
const CITY_KEYS = Object.freeze([
  'city', 'town', 'municipality', 'village',
]);
const BUILDING_KEYS = Object.freeze(['building', 'block', 'unit']);
const CYRILLIC_FOLD = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
  ә: 'a', ң: 'ng', ө: 'o', ұ: 'u', ү: 'u', һ: 'h',
});
const STREET_NOISE_RE = /\b(?:street|st|strada|str|road|rd|avenue|ave|улица|ул|вулиця|вул|kocha|kochasi|кўча|көше)\b/giu;
const QUERY_BUILDING_RE = /(?:корп(?:ус)?\.?|building|bldg\.?|bloc|corp|korpus)\s*([\p{L}\p{N}/-]{1,16})/iu;

let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[’‘ʻʼ`´]/gu, "'")
    .replace(STREET_NOISE_RE, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function foldCyrillic(value) {
  return normalizeText(value)
    .split('')
    .map((char) => CYRILLIC_FOLD[char] ?? char)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function comparableForms(value) {
  const direct = normalizeText(value);
  const folded = foldCyrillic(value);
  return [...new Set([direct, folded].filter(Boolean))];
}

function phraseContains(haystack, needle) {
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  const compactHaystack = haystack.replace(/\s+/gu, '');
  const compactNeedle = needle.replace(/\s+/gu, '');
  if (compactHaystack === compactNeedle) return true;
  const tokenCount = needle.split(' ').filter(Boolean).length;
  if (needle.length < 6 && tokenCount < 2) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function textCompatible(expected, actual) {
  const expectedForms = comparableForms(expected);
  const actualForms = comparableForms(actual);
  if (!expectedForms.length || !actualForms.length) return false;
  return expectedForms.some((a) => actualForms.some((b) =>
    phraseContains(a, b) || phraseContains(b, a),
  ));
}

function normalizeHouseNumber(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[№#]/gu, '')
    .replace(/(?:корп(?:ус)?|корпус|building|bldg|bloc|corp)/gu, 'к')
    .replace(/[^\p{L}\p{N}/-]+/gu, '');
}

function expectationForQuery(query, expectation = {}) {
  if (expectation.building || expectation.kind !== 'address' || !expectation.houseNumber) return expectation;
  const match = String(query || '').match(QUERY_BUILDING_RE);
  return match?.[1]
    ? { ...expectation, building: match[1] }
    : expectation;
}

function expectationCachePart(expectation = {}) {
  const kind = String(expectation.kind || 'any').toLowerCase();
  const house = normalizeHouseNumber(expectation.houseNumber);
  const building = normalizeHouseNumber(expectation.building);
  const street = foldCyrillic(expectation.street);
  const name = foldCyrillic(expectation.name);
  const city = foldCyrillic(expectation.city);
  return [kind, house, building, street, name, city].map((value) => encodeURIComponent(value || '-')).join(':');
}

export function nominatimCacheKey(query, countryCode, expectation = {}) {
  const country = countryCode ? `${countryCode.toLowerCase()}:` : '';
  const normalizedQuery = String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const effectiveExpectation = expectationForQuery(query, expectation);
  return `geo:v5:${country}${expectationCachePart(effectiveExpectation)}:${normalizedQuery}`;
}

export async function cachedNominatimPoint(query, countryCode, expectation = {}) {
  const cached = await cacheGet(nominatimCacheKey(query, countryCode, expectation));
  return cached ? cached.coords : undefined;
}

function addressValues(result, keys) {
  const address = result?.address && typeof result.address === 'object' ? result.address : {};
  return keys.map((key) => address[key]).filter(Boolean);
}

function resultStreetNames(result) {
  return addressValues(result, STREET_KEYS);
}

function resultCityNames(result) {
  return addressValues(result, CITY_KEYS);
}

function resultNames(result) {
  const namedetails = result?.namedetails && typeof result.namedetails === 'object'
    ? Object.values(result.namedetails)
    : [];
  return [result?.name, ...namedetails].filter(Boolean);
}

function resultCountryCode(result) {
  return String(result?.address?.country_code || '').trim().toUpperCase();
}

function resultHouseNumber(result) {
  return normalizeHouseNumber(result?.address?.house_number);
}

function displayContains(result, value) {
  if (!value || !result?.display_name) return false;
  const expectedForms = comparableForms(value);
  const displayForms = comparableForms(result.display_name);
  return expectedForms.some((a) => displayForms.some((b) => phraseContains(b, a)));
}

function streetMatches(result, expectedStreet) {
  if (!expectedStreet) return true;
  const names = resultStreetNames(result);
  if (names.length) return names.some((value) => textCompatible(expectedStreet, value));
  return displayContains(result, expectedStreet);
}

function entityMatches(result, expectedName) {
  if (!expectedName) return true;
  const names = resultNames(result);
  if (names.length) return names.some((value) => textCompatible(expectedName, value));
  return displayContains(result, expectedName);
}

function cityMatches(result, expectedCity, countryCode) {
  if (!expectedCity) return true;
  const expectedCanonical = canonicalCityName(countryCode, expectedCity) || expectedCity;
  const names = resultCityNames(result);
  if (names.length) {
    return names.some((value) => {
      const actualCanonical = canonicalCityName(countryCode, value) || value;
      return textCompatible(expectedCanonical, actualCanonical)
        || textCompatible(expectedCity, value);
    });
  }
  return displayContains(result, expectedCanonical) || displayContains(result, expectedCity);
}

function houseMatches(result, expectedHouse, expectedBuilding) {
  const actualHouse = resultHouseNumber(result);
  if (!expectedHouse || !actualHouse) return false;
  if (!expectedBuilding) return actualHouse === expectedHouse;

  const building = normalizeHouseNumber(expectedBuilding);
  const compound = new Set([
    `${expectedHouse}/${building}`,
    `${expectedHouse}-${building}`,
    `${expectedHouse}к${building}`,
    `${expectedHouse}${building}`,
  ]);
  if (compound.has(actualHouse)) return true;
  if (actualHouse !== expectedHouse) return false;

  return addressValues(result, BUILDING_KEYS)
    .map(normalizeHouseNumber)
    .some((value) => value === building);
}

function pointFromResult(result, expectation = {}) {
  const lat = Number(result?.lat);
  const lng = Number(result?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const kind = expectation.kind || 'any';
  const precision = kind === 'address' && expectation.houseNumber
    ? 'building'
    : kind === 'street' || (kind === 'address' && expectation.street)
      ? 'street'
      : null;

  return {
    lat,
    lng,
    precision,
    accuracyM: null,
    provider: 'nominatim',
    providerId: result?.osm_type && result?.osm_id != null
      ? `${result.osm_type}:${result.osm_id}`
      : null,
    providerType: result?.addresstype || result?.type || result?.class || null,
    placeRank: Number.isFinite(Number(result?.place_rank)) ? Number(result.place_rank) : null,
  };
}

export function selectNominatimPoint(data, expectation = {}, countryCode = null) {
  if (!Array.isArray(data)) return null;
  const expectedCountry = String(countryCode || '').trim().toUpperCase();
  const expectedHouse = normalizeHouseNumber(expectation.houseNumber);
  const expectedBuilding = normalizeHouseNumber(expectation.building);
  const expectedStreet = expectation.street || null;
  const expectedName = expectation.name || null;
  const kind = expectation.kind || 'any';

  const accepted = [];
  for (const result of data) {
    const point = pointFromResult(result, expectation);
    if (!point) continue;

    const resultCountry = resultCountryCode(result);
    if (expectedCountry && resultCountry !== expectedCountry) continue;
    if (expectation.city && !cityMatches(result, expectation.city, expectedCountry)) continue;

    const provedHouse = expectedHouse && houseMatches(result, expectedHouse, expectedBuilding);
    if (kind === 'address' && expectedHouse) {
      if (!provedHouse) continue;
      if (expectedStreet && !streetMatches(result, expectedStreet)) continue;
    } else if ((kind === 'street' || (kind === 'address' && expectedStreet))
      && expectedStreet && !streetMatches(result, expectedStreet)) {
      continue;
    } else if (kind === 'address' && !expectedHouse && !expectedStreet) {
      if (!resultHouseNumber(result) && !resultStreetNames(result).length) continue;
    } else if (kind === 'entity' && expectedName && !entityMatches(result, expectedName)) {
      continue;
    }

    let score = 0;
    if (provedHouse) score += 100;
    if (expectedStreet && streetMatches(result, expectedStreet)) score += 40;
    if (expectedName && entityMatches(result, expectedName)) score += 40;
    if (expectation.city && cityMatches(result, expectation.city, expectedCountry)) score += 20;
    if (/^(?:house|building|apartments|residential)$/iu.test(String(result?.addresstype || result?.type || ''))) score += 10;
    score += Math.max(0, Math.min(1, Number(result?.importance) || 0));
    accepted.push({ point, score });
  }

  accepted.sort((a, b) => b.score - a.score);
  return accepted[0]?.point || null;
}

export function selectNominatimBbox(data, countryCode = null, expectedCity = null) {
  if (!Array.isArray(data)) return null;
  const expectedCountry = String(countryCode || '').trim().toUpperCase();

  for (const result of data) {
    if (expectedCountry && resultCountryCode(result) !== expectedCountry) continue;
    if (expectedCity && !cityMatches(result, expectedCity, expectedCountry)) continue;
    const raw = result?.boundingbox;
    const numbers = (raw || []).map(Number);
    if (numbers.length !== 4 || !numbers.every(Number.isFinite)) continue;
    return [numbers[0], numbers[2], numbers[1], numbers[3]];
  }
  return null;
}

export async function fetchNominatimPoint(query, countryCode, expectation = {}) {
  await throttle();
  const effectiveExpectation = expectationForQuery(query, expectation);
  const key = nominatimCacheKey(query, countryCode, effectiveExpectation);
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '5',
      addressdetails: '1',
      namedetails: '1',
    });
    if (countryCode) params.set('countrycodes', countryCode.toLowerCase());
    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en,ru,uk,uz,kk,ro' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`nominatim ${response.status}`);
    const data = await response.json();
    const coords = selectNominatimPoint(data, effectiveExpectation, countryCode);
    await cacheSet(key, { coords }, coords ? HIT_TTL_MS : MISS_TTL_MS);
    return coords;
  } catch {
    await cacheSet(key, { coords: null }, ERROR_TTL_MS);
    return null;
  }
}

export async function geocodeQuery(query, countryCode, expectation = {}) {
  if (!query) return null;
  const cached = await cachedNominatimPoint(query, countryCode, expectation);
  return cached === undefined ? fetchNominatimPoint(query, countryCode, expectation) : cached;
}

export async function geocodeBbox(query, countryCode = null, expectedCity = null) {
  if (!query) return null;
  const country = String(countryCode || '').toLowerCase();
  const city = foldCyrillic(expectedCity || '');
  const key = `geo:bbox:v2:${country || '-'}:${encodeURIComponent(city || '-')}:${query.toLowerCase().trim()}`;
  const cached = await cacheGet(key);
  if (cached) return cached.bbox;

  await throttle();
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '5',
      addressdetails: '1',
    });
    if (countryCode) params.set('countrycodes', String(countryCode).toLowerCase());
    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en,ru,uk,uz,kk,ro' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`nominatim ${response.status}`);
    const data = await response.json();
    const bbox = selectNominatimBbox(data, countryCode, expectedCity);
    await cacheSet(key, { bbox }, bbox ? HIT_TTL_MS : MISS_TTL_MS);
    return bbox;
  } catch {
    await cacheSet(key, { bbox: null }, ERROR_TTL_MS);
    return null;
  }
}
