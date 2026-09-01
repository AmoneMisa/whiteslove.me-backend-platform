// nearestAddressToMetro/nearestMetroToAddress ship in @whiteslove/geo-catalog
// from 0.5.0 onward (package.json is pinned there or newer). Imported as a
// namespace (not named imports) so an unexpectedly older installed version
// missing those two exports fails at call time with a clear message instead
// of a hard SyntaxError at module load that would take down the whole process.
import * as geoCatalog from '@whiteslove/geo-catalog';
import { pool } from './db.js';

const { resolveLexiconGeoEntity } = geoCatalog;

function requireLibFn(name) {
  const fn = geoCatalog[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `The installed @whiteslove/geo-catalog does not export ${name} — ` +
      'bump the @whiteslove/geo-catalog dependency to >=0.5.0.',
    );
  }
  return fn;
}

const DEFAULT_MAX_DISTANCE_KM = 3;
const DEFAULT_ROW_LIMIT = 500;
const KM_PER_DEGREE_LAT = 111.32;

// learned_geo accumulates addresses in real time as listings get geocoded; the
// daily exporter (learned-geo-export.js) is what eventually promotes rows into
// the @whiteslove/geo-catalog package's static LEARNED_ADDRESS_ENTITIES. Until
// a row is exported it only exists here, so proximity queries against
// not-yet-exported addresses have to hit Postgres directly instead of relying
// on the packaged catalog.
function bboxAround(point, radiusKm) {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;
  const lngDelta = radiusKm / (KM_PER_DEGREE_LAT * Math.cos((point.lat * Math.PI) / 180) || 1);
  return {
    minLat: point.lat - latDelta,
    maxLat: point.lat + latDelta,
    minLng: point.lng - lngDelta,
    maxLng: point.lng + lngDelta,
  };
}

function rowToAddressEntity(row, country) {
  return Object.freeze({
    id: `learned-geo:${row.lookup_key}`,
    type: 'address',
    country,
    canonicalName: row.canonical_name,
    center: { lat: Number(row.lat), lng: Number(row.lng) },
    accuracyM: row.accuracy_m != null ? Number(row.accuracy_m) : undefined,
  });
}

/**
 * Load learned_geo address rows within radiusKm of a point, pre-filtered by a
 * bounding box in SQL so the exact haversine ranking in geo-catalog only runs
 * over a small, already-nearby candidate set instead of the whole table.
 */
export async function loadLearnedAddressesNear(country, point, radiusKm = DEFAULT_MAX_DISTANCE_KM, limit = DEFAULT_ROW_LIMIT) {
  const bbox = bboxAround(point, radiusKm);
  const result = await pool.query(
    `SELECT lookup_key, canonical_name, lat, lng, accuracy_m
       FROM learned_geo
      WHERE entity_type = 'address'
        AND country = $1
        AND lat BETWEEN $2 AND $3
        AND lng BETWEEN $4 AND $5
      LIMIT $6`,
    [country, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng, limit],
  );
  return result.rows.map((row) => rowToAddressEntity(row, country));
}

/**
 * Nearest learned_geo address to a metro station, by lexicon canonical name.
 * Resolves the station via geo-catalog's static catalog (stations don't move,
 * so they don't need a live query), pulls nearby address rows from Postgres,
 * then ranks them with geo-catalog's nearestAddressToMetro.
 */
export async function nearestAddressToMetro(
  { country, city, canonical },
  { maxDistanceKm = DEFAULT_MAX_DISTANCE_KM, limit = DEFAULT_ROW_LIMIT } = {},
) {
  const station = resolveLexiconGeoEntity({ country, city, type: 'metro', canonical });
  if (!station) return null;

  const addresses = await loadLearnedAddressesNear(country, station.center, maxDistanceKm, limit);
  if (!addresses.length) return null;

  return requireLibFn('nearestAddressToMetro')({ country, city, canonical }, addresses, { maxDistanceKm });
}

/**
 * Reverse direction: nearest metro station to a learned_geo address row,
 * looked up by its lookup_key (see buildGeoLookupKey in @whiteslove/geo-catalog).
 * Metro stations are static, so this is a plain coordinate lookup once the
 * address's lat/lng is fetched.
 */
export async function nearestMetroToAddress(lookupKey, { country, maxDistanceKm = DEFAULT_MAX_DISTANCE_KM } = {}) {
  if (!lookupKey) return null;
  const result = await pool.query(
    `SELECT lat, lng FROM learned_geo WHERE lookup_key = $1 LIMIT 1`,
    [lookupKey],
  );
  const row = result.rows[0];
  if (!row) return null;

  const point = { lat: Number(row.lat), lng: Number(row.lng) };
  return requireLibFn('nearestMetroToAddress')(point, { country, maxDistanceKm });
}
