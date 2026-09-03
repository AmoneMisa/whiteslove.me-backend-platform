// Administrative location and best-effort address from coordinates.
//
// The text resolver only knows what a post spells out, so listings routinely
// arrive with useful geo anchors but no postal address. Reverse geocoding fills
// the hierarchy and may provide a display address, while preserving provenance
// so an inferred nearby road/house is never confused with a source-stated one.

import { cacheGet, cacheSet } from '../support/cache.js';
import { canonicalCityName } from './countries.js';
import { matchDictionaryEntities } from './location-dictionary-resolver.js';

const REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const UA = 'flat-finder/1.0 (housing aggregator; contact: admin@whiteslove.me)';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 1100;
const LOOKUPS_PER_RUN = Number(process.env.REVERSE_GEOCODE_BUDGET) || 40;
// ~11 m: two listings in one building share an answer, and the cache actually
// gets hits instead of a fresh key per nearby coordinate.
const KEY_PRECISION = 4;
const ROAD_SAFE_PRECISIONS = new Set(['building', 'street', 'complex', 'station', 'reference']);

let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
}

function cacheKey(lat, lng) {
  return `geo:reverse:v1:${lat.toFixed(KEY_PRECISION)}:${lng.toFixed(KEY_PRECISION)}`;
}

/** Strips the noise words OSM appends to mahalla/district names. */
function cleanPlace(value) {
  return String(value || '')
    .replace(/\s*(?:махалл[яи]|mahalla|MFY|мфй|район[а-яё]*|tumani|district|shahri|city)\s*$/iu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizedPlace(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

async function fetchReverse(lat, lng) {
  await throttle();
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lng),
    zoom: '18',
    addressdetails: '1',
  });
  const res = await fetch(`${REVERSE_URL}?${params}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`nominatim reverse ${res.status}`);
  const data = await res.json();
  return data?.address || null;
}

/** Raw address components for a point, cached. Null when unknown. */
export async function reverseGeocode(lat, lng) {
  const key = cacheKey(lat, lng);
  const cached = await cacheGet(key);
  if (cached) return cached.address;

  try {
    const address = await fetchReverse(lat, lng);
    await cacheSet(key, { address }, address ? CACHE_TTL_MS : MISS_TTL_MS);
    return address;
  } catch {
    await cacheSet(key, { address: null }, MISS_TTL_MS);
    return null;
  }
}

function normalizeSourceCoordinateConfidence(listing) {
  // Raw marketplace pins do not carry a documented accuracy radius in our
  // normalized source model. Treat the generic `coordinates` marker as an
  // approximate point until an exact address independently corroborates it.
  // Explicit semantic precision from a stronger upstream path is preserved.
  if (listing.locationSource !== 'coordinates') return;
  if (listing.locationPrecision && listing.locationPrecision !== 'coordinates') return;
  listing.locationPrecision = 'broad';
  listing.locationApproximate = true;
  listing.locationAccuracyM = Number.isFinite(Number(listing.locationAccuracyM))
    ? Number(listing.locationAccuracyM)
    : null;
}

function canUseReverseHouseNumber(listing) {
  // A reverse service returns the nearest building number to any point. Only a
  // building-level point backed by the listing's own exact address may expose a
  // house number. A marketplace pin, ЖК centroid, metro, POI or neighbourhood
  // point must never manufacture an apartment's building number.
  if (listing.locationApproximate !== false) return false;
  if (listing.locationPrecision !== 'building') return false;
  if (listing.locationSource !== 'address' && listing.locationSource !== 'coordinates-validated') return false;
  return Boolean(listing.houseNumber || listing.addressPrecision === 'building');
}

function canUseReverseRoad(listing) {
  // A road is useful for a specific building/street/ЖК/station/reference anchor,
  // but it is arbitrary at a district/neighbourhood centroid or an unverified
  // marketplace pin. Those broader points are used only for admin enrichment.
  return ROAD_SAFE_PRECISIONS.has(String(listing.locationPrecision || ''));
}

function rejectGeneratedCoordinate(listing, reason) {
  // Marketplace/source coordinates and canonical geo-catalog anchors have
  // stronger provenance than a reverse service and are never erased here.
  // Everything else (Nominatim, learned Nominatim results, legacy HTTP/cache
  // placement, spatial inference) is generated evidence and may be rejected.
  if (listing.locationProvider === 'geoCatalog') return false;
  if (['coordinates', 'coordinates-validated'].includes(listing.locationSource)) return false;

  listing.locationRejected = reason;
  listing.lat = null;
  listing.lng = null;
  listing.locationSource = null;
  listing.locationAccuracyM = null;
  listing.locationPrecision = null;
  listing.locationApproximate = true;
  listing.locationCanonical = null;
  listing.locationRole = null;
  return true;
}

function knownCityMismatch(listing, country, address, matched) {
  const countryCode = String(country?.code || '').toUpperCase();
  const expected = canonicalCityName(countryCode, listing?.city || '');
  const reverse = canonicalCityName(
    countryCode,
    address?.city || address?.town || matched?.city || '',
  );
  if (!expected || !reverse || normalizedPlace(expected) === normalizedPlace(reverse)) return null;

  // A listing can legitimately be stored under a metro/search city while its
  // physical point is in a neighbouring suburb (e.g. Odesa/Fontanka). Reject a
  // generated point only when reverse geocoding identifies another known target
  // city of the same country. This catches gross Tashkent→Samarkand-style errors
  // without discarding valid metropolitan-edge coordinates.
  const knownCities = new Set([
    ...(country?.crawlCities || []),
    ...(country?.cities || []),
  ].map((city) => normalizedPlace(canonicalCityName(countryCode, city))).filter(Boolean));

  return knownCities.has(normalizedPlace(expected)) && knownCities.has(normalizedPlace(reverse))
    ? { expected, reverse }
    : null;
}

function needsReverse(listing) {
  if (!Number.isFinite(listing?.lat) || !Number.isFinite(listing?.lng)) return false;
  if (listing.locationSource === 'city' || listing.locationPrecision === 'city') return false;
  return !listing.district
    || !listing.microdistrict
    || !listing.city
    || !listing.country
    || !listing.address;
}

/**
 * Fills country/city/district/microdistrict and, when safe, an explicitly
 * inferred road/address for listings that already have coordinates.
 */
export async function applyReverseGeo(listings, country, limit = LOOKUPS_PER_RUN) {
  if (!Array.isArray(listings)) return 0;
  const countryCode = String(country?.code || '').toUpperCase();

  for (const listing of listings) normalizeSourceCoordinateConfidence(listing);
  const candidates = listings.filter(needsReverse);

  let spent = 0;
  let filled = 0;
  for (const listing of candidates) {
    const cached = await cacheGet(cacheKey(listing.lat, listing.lng));
    if (!cached && spent >= limit) continue;
    if (!cached) spent += 1;

    const address = await reverseGeocode(listing.lat, listing.lng);
    if (!address) continue;

    // A generated point that reverse-geocodes to the wrong country is discarded
    // instead of being shown with false precision. Source/catalog coordinates are
    // preserved but never enriched from the conflicting reverse result.
    if (countryCode && address.country_code && String(address.country_code).toUpperCase() !== countryCode) {
      console.warn(`[geocode] reverse geo country mismatch for listing ${listing.id}: expected ${countryCode}, got ${String(address.country_code).toUpperCase()} at ${listing.lat},${listing.lng}`);
      if (!rejectGeneratedCoordinate(listing, 'country-mismatch')) {
        listing.locationValidationWarning = 'country-mismatch';
      }
      continue;
    }

    const parts = [
      address.neighbourhood,
      address.quarter,
      address.suburb,
      address.city_district,
      address.county,
      address.state,
      address.city || address.town,
    ]
      .filter(Boolean)
      .join(', ');

    const matched = matchDictionaryEntities(parts, countryCode, listing.city || undefined);
    const cityMismatch = knownCityMismatch(listing, country, address, matched);
    if (cityMismatch) {
      console.warn(`[geocode] reverse geo city mismatch for listing ${listing.id}: expected ${cityMismatch.expected}, got ${cityMismatch.reverse} at ${listing.lat},${listing.lng}`);
      if (!rejectGeneratedCoordinate(listing, 'city-mismatch')) {
        listing.locationValidationWarning = 'city-mismatch';
      }
      continue;
    }

    let changed = false;
    if (!listing.country && address.country_code) {
      listing.country = String(address.country_code).toUpperCase();
      changed = true;
    }
    if (!listing.city && (matched.city || address.city || address.town)) {
      listing.city = matched.city || cleanPlace(address.city || address.town);
      changed = true;
    }
    // Filterable, so only a value the dictionary knows is acceptable.
    if (!listing.district && matched.district) {
      listing.district = matched.district;
      changed = true;
    }
    if (!listing.microdistrict) {
      const micro = matched.microdistrict || cleanPlace(address.neighbourhood || address.quarter || address.suburb);
      if (micro) {
        listing.microdistrict = micro;
        changed = true;
      }
    }
    if (!listing.address && address.road && canUseReverseRoad(listing)) {
      const houseNumber = canUseReverseHouseNumber(listing) ? address.house_number : null;
      listing.address = [address.road, houseNumber].filter(Boolean).join(' ');
      listing.addressSource = 'reverseGeocode';
      listing.addressApproximate = !houseNumber;
      listing.addressPrecision = houseNumber ? 'building' : 'street';
      changed = true;
    } else if (listing.address) {
      listing.addressSource ??= 'source';
      listing.addressApproximate ??= listing.addressPrecision !== 'building';
    }

    if (changed) {
      listing.adminSource = 'coordinates';
      filled += 1;
    }
  }

  if (filled) console.log(`[geocode] admin/address from coordinates: ${filled}/${candidates.length}`);
  return filled;
}
