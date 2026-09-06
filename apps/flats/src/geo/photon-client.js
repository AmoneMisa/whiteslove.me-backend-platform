import { cacheGet, cacheSet } from '../support/cache.js';
import { canonicalCityName } from './countries.js';

const PHOTON_URL = String(process.env.PHOTON_URL || 'https://photon.komoot.io').replace(/\/$/u, '');
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const MIN_INTERVAL_MS = Math.max(1000, Number(process.env.PHOTON_MIN_INTERVAL_MS) || 1500);
const EARTH_RADIUS_M = 6_371_000;
const DEGREE_M = (Math.PI / 180) * EARTH_RADIUS_M;
const LEVEL_EXTENT_M = Object.freeze({
  street: 900,
  complex: 350,
  station: 300,
  reference: 500,
  neighborhood: 1200,
  locality: 3500,
  district: 7000,
});
const POINT_LIKE_LEVELS = new Set(['street', 'complex', 'station', 'reference']);
const BROAD_OSM_VALUES = new Set([
  'administrative', 'city', 'town', 'village', 'hamlet', 'suburb', 'quarter',
  'neighbourhood', 'neighborhood', 'county', 'state', 'region',
]);
const CYRILLIC_FOLD = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
  ә: 'a', ң: 'ng', ө: 'o', ұ: 'u', ү: 'u', һ: 'h',
});

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
  return [...new Set([normalizeText(value), foldCyrillic(value)].filter(Boolean))];
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
  return expectedForms.some((a) => actualForms.some((b) =>
    phraseContains(a, b) || phraseContains(b, a),
  ));
}

function expectationCachePart(expectation = {}) {
  return [
    String(expectation.kind || 'any').toLowerCase(),
    foldCyrillic(expectation.name),
    foldCyrillic(expectation.street),
    foldCyrillic(expectation.city),
    String(expectation.level || '').toLowerCase(),
  ].map((value) => encodeURIComponent(value || '-')).join(':');
}

export function photonCacheKey(query, countryCode, expectation = {}) {
  const country = String(countryCode || '').trim().toLowerCase() || '-';
  const normalizedQuery = normalizeText(query);
  return `geo:photon:v1:${country}:${expectationCachePart(expectation)}:${normalizedQuery}`;
}

export function supportsPhotonExpectation(expectation = {}) {
  const kind = String(expectation.kind || 'any');
  if (kind === 'address' && expectation.houseNumber) return false;
  return kind === 'entity' || kind === 'street' || (kind === 'address' && expectation.street);
}

export async function cachedPhotonPoint(query, countryCode, expectation = {}) {
  if (!supportsPhotonExpectation(expectation)) return null;
  const cached = await cacheGet(photonCacheKey(query, countryCode, expectation));
  return cached ? cached.coords : undefined;
}

function featureProperties(feature) {
  return feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
}

function featureCountryCode(feature) {
  const properties = featureProperties(feature);
  return String(properties.countrycode || properties.country_code || '').trim().toUpperCase();
}

function featureCityNames(feature) {
  const properties = featureProperties(feature);
  return [properties.city, properties.locality, properties.district, properties.county].filter(Boolean);
}

function featureNames(feature) {
  const properties = featureProperties(feature);
  return [properties.name, properties.street].filter(Boolean);
}

function featureExtentM(feature) {
  const properties = featureProperties(feature);
  const raw = Array.isArray(properties.extent)
    ? properties.extent
    : (Array.isArray(feature?.bbox) ? feature.bbox : null);
  const box = (raw || []).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite)) return null;

  // Photon/GeoJSON extents are west,south,east,north.
  const [west, south, east, north] = box;
  const midLat = (((south + north) / 2) * Math.PI) / 180;
  const heightM = Math.abs(north - south) * DEGREE_M;
  const widthM = Math.abs(east - west) * DEGREE_M * Math.cos(midLat);
  const extentM = Math.hypot(widthM, heightM) / 2;
  return Number.isFinite(extentM) ? Math.round(extentM) : null;
}

function cityMatches(feature, expectedCity, countryCode) {
  if (!expectedCity) return true;
  const expectedCanonical = canonicalCityName(countryCode, expectedCity) || expectedCity;
  const names = featureCityNames(feature);
  if (!names.length) return false;
  return names.some((value) => {
    const actualCanonical = canonicalCityName(countryCode, value) || value;
    return textCompatible(expectedCanonical, actualCanonical)
      || textCompatible(expectedCity, value);
  });
}

function nameMatches(feature, expectedName) {
  if (!expectedName) return true;
  const names = featureNames(feature);
  return names.some((value) => textCompatible(expectedName, value));
}

function semanticTypeCompatible(feature, expectation = {}) {
  const properties = featureProperties(feature);
  const level = String(expectation.level || '');
  const osmKey = String(properties.osm_key || '').toLowerCase();
  const osmValue = String(properties.osm_value || '').toLowerCase();

  if (POINT_LIKE_LEVELS.has(level)
    && (osmKey === 'boundary' || BROAD_OSM_VALUES.has(osmValue))) {
    return false;
  }
  if (level === 'street') {
    return osmKey === 'highway' || Boolean(properties.street);
  }
  if (level === 'station') {
    return ['railway', 'public_transport'].includes(osmKey)
      || /^(?:station|halt|stop|subway_entrance)$/u.test(osmValue);
  }
  return true;
}

function extentContradictsLevel(level, extentM) {
  if (!POINT_LIKE_LEVELS.has(String(level || '')) || extentM == null) return false;
  const expected = LEVEL_EXTENT_M[level];
  return Boolean(expected) && extentM > expected * 25;
}

function precisionForLevel(level, kind) {
  if (level === 'complex') return 'complex';
  if (level === 'station') return 'station';
  if (level === 'reference') return 'reference';
  if (level === 'street' || kind === 'street') return 'street';
  if (level === 'neighborhood') return 'neighborhood';
  if (level === 'locality') return 'locality';
  if (level === 'district') return 'district';
  return null;
}

function pointFromFeature(feature, expectation = {}) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lng = Number(coordinates[0]);
  const lat = Number(coordinates[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const properties = featureProperties(feature);
  return {
    lat,
    lng,
    precision: precisionForLevel(expectation.level, expectation.kind),
    accuracyM: null,
    extentM: featureExtentM(feature),
    provider: 'photon',
    providerId: properties.osm_type && properties.osm_id != null
      ? `${properties.osm_type}:${properties.osm_id}`
      : null,
    providerType: [properties.osm_key, properties.osm_value].filter(Boolean).join(':') || null,
  };
}

export function selectPhotonPoint(data, expectation = {}, countryCode = null) {
  if (!supportsPhotonExpectation(expectation) || !Array.isArray(data?.features)) return null;
  const expectedCountry = String(countryCode || '').trim().toUpperCase();
  const expectedName = expectation.kind === 'street'
    ? (expectation.street || expectation.name)
    : (expectation.name || expectation.street);

  const accepted = [];
  for (const feature of data.features) {
    const point = pointFromFeature(feature, expectation);
    if (!point) continue;
    if (expectedCountry && featureCountryCode(feature) !== expectedCountry) continue;
    if (!cityMatches(feature, expectation.city, expectedCountry)) continue;
    if (!nameMatches(feature, expectedName)) continue;
    if (!semanticTypeCompatible(feature, expectation)) continue;
    if (extentContradictsLevel(expectation.level, point.extentM)) continue;

    const properties = featureProperties(feature);
    let score = 0;
    if (expectedName && nameMatches(feature, expectedName)) score += 40;
    if (expectation.city && cityMatches(feature, expectation.city, expectedCountry)) score += 20;
    if (point.extentM != null && LEVEL_EXTENT_M[expectation.level]) {
      const ratio = Math.max(1, point.extentM) / LEVEL_EXTENT_M[expectation.level];
      score += 30 / (1 + Math.abs(Math.log10(ratio)));
    }
    score += Math.max(0, Math.min(1, Number(properties.importance) || 0));
    accepted.push({ point, score });
  }

  accepted.sort((a, b) => b.score - a.score);
  return accepted[0]?.point || null;
}

export async function fetchPhotonPoint(query, countryCode, expectation = {}) {
  if (!query || !supportsPhotonExpectation(expectation)) return null;
  await throttle();
  const key = photonCacheKey(query, countryCode, expectation);
  try {
    const params = new URLSearchParams({ q: query, limit: '10' });
    const response = await fetch(`${PHOTON_URL}/api?${params}`, {
      headers: {
        'User-Agent': 'flat-finder/1.0 (housing aggregator; contact: admin@whiteslove.me)',
        'Accept-Language': 'en,ru,uk,uz,kk,ro',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`photon ${response.status}`);
    const data = await response.json();
    const coords = selectPhotonPoint(data, expectation, countryCode);
    await cacheSet(key, { coords }, coords ? HIT_TTL_MS : MISS_TTL_MS);
    return coords;
  } catch {
    await cacheSet(key, { coords: null }, ERROR_TTL_MS);
    return null;
  }
}

export async function geocodePhotonPoint(query, countryCode, expectation = {}) {
  if (!query || !supportsPhotonExpectation(expectation)) return null;
  const cached = await cachedPhotonPoint(query, countryCode, expectation);
  return cached === undefined ? fetchPhotonPoint(query, countryCode, expectation) : cached;
}
