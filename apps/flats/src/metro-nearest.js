// Nearest-station fallback for the `metro` field.
//
// The dictionary resolver only fills `metro` when the post names the station,
// so a flat two streets from Novza that never mentions it stays unassigned —
// which is why filtering by a station returned a fraction of what is actually
// there. Once a listing has coordinates, the station is a distance calculation.
//
// Station coordinates come from the same Nominatim path as everything else
// (injected, so this module never imports the geocoder back) and are cached for
// a month: 50 stations do not move.

import { cacheGet, cacheSet } from './cache.js';
import { TASHKENT_METRO } from './tashkent-metro.js';

const EARTH_RADIUS_M = 6_371_000;
// Tashkent stations sit ~1.5-2 km apart, so this is "the station you would
// actually walk to" rather than "the station that happens to be closest".
const RADIUS_M = 1200;
// Coordinates derived from a district or city centre say nothing about which
// station is near; only reasonably precise placements may name one.
const MAX_ACCURACY_M = 800;
// Stations are looked up a few per run, so a cold cache fills over a handful of
// refreshes instead of spending the whole geocoding budget at once.
const LOOKUPS_PER_RUN = 6;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const memo = new Map();

function cacheKey(name) {
  return `geo:metro-station:v1:${name.toLowerCase()}`;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function distanceM(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest station to a point, or null when none is within walking distance. */
export function nearestStation(point, stations, radiusM = RADIUS_M) {
  let best = null;
  for (const [name, coords] of stations) {
    if (!coords) continue;
    const distance = distanceM(point, coords);
    if (distance <= radiusM && (!best || distance < best.distanceM)) {
      best = { name, distanceM: distance };
    }
  }
  return best;
}

/**
 * Station coordinates, filling gaps through `lookup` a few at a time.
 * `lookup(query)` is the geocoder's cached+throttled resolver.
 */
export async function stationCoordinates(lookup, limit = LOOKUPS_PER_RUN) {
  let spent = 0;
  for (const station of TASHKENT_METRO) {
    if (memo.has(station.name)) continue;

    const cached = await cacheGet(cacheKey(station.name));
    if (cached) {
      memo.set(station.name, cached.coords || null);
      continue;
    }

    if (spent >= limit || typeof lookup !== 'function') continue;
    spent += 1;

    // OSM files these as "Novza (Hamza)" / "Novza metro bekati", so the English
    // phrasing "<name> metro station, Tashkent" finds nothing. A plain
    // "<name>, Tashkent, Uzbekistan" resolves, and the Russian "метро <name>"
    // covers the stations whose Latin spelling OSM does not carry.
    let coords = null;
    for (const query of [
      `${station.labels?.en || station.name}, Tashkent, Uzbekistan`,
      station.labels?.ru ? `метро ${station.labels.ru} Ташкент` : null,
    ].filter(Boolean)) {
      coords = await lookup(query);
      if (coords) break;
      spent += 1;
    }

    memo.set(station.name, coords || null);
    await cacheSet(cacheKey(station.name), { coords: coords || null }, CACHE_TTL_MS);
  }
  return memo;
}

/**
 * Fills `metro` for Tashkent listings that have precise-enough coordinates and
 * no station from the text. Never overwrites a station the post named itself.
 */
export async function assignNearestMetro(listings, country, lookup) {
  if (!Array.isArray(listings) || String(country?.code || '').toUpperCase() !== 'UZ') return 0;

  const candidates = listings.filter(
    (listing) =>
      !listing.metro &&
      Number.isFinite(listing.lat) &&
      Number.isFinite(listing.lng) &&
      (listing.locationAccuracyM ?? Number.POSITIVE_INFINITY) <= MAX_ACCURACY_M &&
      (!listing.city || listing.city === 'Tashkent'),
  );
  if (!candidates.length) return 0;

  const stations = await stationCoordinates(lookup);
  let assigned = 0;
  for (const listing of candidates) {
    const nearest = nearestStation({ lat: listing.lat, lng: listing.lng }, stations);
    if (!nearest) continue;
    listing.metro = nearest.name;
    listing.metroSource = 'coordinates';
    listing.metroDistanceM = Math.round(nearest.distanceM);
    assigned += 1;
  }
  if (assigned) console.log(`[geocode] metro from coordinates: ${assigned}/${candidates.length}`);
  return assigned;
}
