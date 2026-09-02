// Administrative location from coordinates.
//
// The text resolver only knows what a post spells out, so listings routinely
// arrive with a price, a photo and no idea which district they are in. Once a
// listing has coordinates, Nominatim's reverse endpoint answers the whole
// hierarchy — mahalla, district, city, country — in one cached call.
//
// District values feed a filter dropdown, so they are only accepted when the
// project dictionary recognises them; a raw OSM string would create a filter
// option nothing else in the system uses. Microdistrict is display-only and may
// keep the OSM name.

import { cacheGet, cacheSet } from '../support/cache.js';
import { matchDictionaryEntities } from './location-dictionary-resolver.js';

const REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const UA = 'flat-finder/1.0 (housing aggregator; contact: admin@whiteslove.me)';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 1100;
const LOOKUPS_PER_RUN = Number(process.env.REVERSE_GEOCODE_BUDGET) || 40;
// ~11 m: two listings in one building share an answer, and the cache actually
// gets hits instead of a fresh key per jittered coordinate.
const KEY_PRECISION = 4;

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

/**
 * Fills country/city/district/microdistrict for listings that already have
 * coordinates. Forward placement and city fallbacks are owned by the geocoding
 * orchestration / geo-catalog, never by the parsing lexicon.
 */
export async function applyReverseGeo(listings, country, limit = LOOKUPS_PER_RUN) {
  if (!Array.isArray(listings)) return 0;
  const countryCode = String(country?.code || '').toUpperCase();

  const candidates = listings.filter(
    (listing) =>
      Number.isFinite(listing.lat) &&
      Number.isFinite(listing.lng) &&
      // A city-centre placement describes the city, nothing finer.
      (listing.locationAccuracyM ?? Number.POSITIVE_INFINITY) <= 2000 &&
      (!listing.district || !listing.microdistrict || !listing.city || !listing.country),
  );

  let spent = 0;
  let filled = 0;
  for (const listing of candidates) {
    const cached = await cacheGet(cacheKey(listing.lat, listing.lng));
    if (!cached && spent >= limit) continue;
    if (!cached) spent += 1;

    const address = await reverseGeocode(listing.lat, listing.lng);
    if (!address) continue;

    // A coordinate that reverse-geocodes to a different country than the
    // crawl's own context is almost certainly a bad/mismatched forward-geocode
    // result upstream (e.g. a district name ambiguously matched abroad), not a
    // legitimate cross-border listing. Trusting it produced nonsense like a
    // Tashkent listing's address showing an Afghan mountain pass's road name.
    if (countryCode && address.country_code && String(address.country_code).toUpperCase() !== countryCode) {
      console.warn(`[geocode] reverse geo country mismatch for listing ${listing.id}: expected ${countryCode}, got ${String(address.country_code).toUpperCase()} at ${listing.lat},${listing.lng}`);
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
    if (!listing.address && address.road) {
      listing.address = [address.road, address.house_number].filter(Boolean).join(' ');
      changed = true;
    }

    if (changed) {
      listing.adminSource = 'coordinates';
      filled += 1;
    }
  }

  if (filled) console.log(`[geocode] admin location from coordinates: ${filled}/${candidates.length}`);
  return filled;
}
