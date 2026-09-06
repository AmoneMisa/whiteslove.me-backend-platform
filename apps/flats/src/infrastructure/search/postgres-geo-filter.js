import {resolvedSearchGeometry} from '../../geo/search-filter-geometry.js';

const EARTH_RADIUS_M = 6_371_008.8;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedBearing(value) {
  const number = finite(value);
  if (number == null) return null;
  const wrapped = number % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function normalizeLongitude(value) {
  const wrapped = ((Number(value) + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function metroNames(filters) {
  const values = Array.isArray(filters?.metros)
    ? filters.metros
    : String(filters?.metro || '').split(',');
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const name = String(value || '').trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function usableCoordinateSql(alias) {
  return `${alias}.lat IS NOT NULL AND ${alias}.lng IS NOT NULL AND ${alias}.lat BETWEEN -90 AND 90 AND ${alias}.lng BETWEEN -180 AND 180`;
}

function ringPolygonText(ring) {
  if (!Array.isArray(ring)) return null;
  const points = [];
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) continue;
    const lng = finite(position[0]);
    const lat = finite(position[1]);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    points.push(`(${lng},${lat})`);
  }
  // GeoJSON rings are normally closed; PostgreSQL polygons close themselves,
  // so keeping or omitting the duplicate endpoint is equivalent. Require at
  // least three distinct vertices to avoid an invalid polygon cast.
  const distinct = new Set(points);
  if (distinct.size < 3) return null;
  return `(${points.join(',')})`;
}

function onePolygonPredicate(alias, coordinates, add) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
  const outer = ringPolygonText(coordinates[0]);
  if (!outer) return null;
  const point = `point(${alias}.lng, ${alias}.lat)`;
  const clauses = [`${point} <@ ${add(outer)}::polygon`];
  // PostgreSQL's native polygon has no hole model. GeoJSON holes are therefore
  // represented explicitly as outer containment minus each inner ring.
  for (const holeRing of coordinates.slice(1)) {
    const hole = ringPolygonText(holeRing);
    if (hole) clauses.push(`NOT (${point} <@ ${add(hole)}::polygon)`);
  }
  return `(${clauses.join(' AND ')})`;
}

function boundaryPredicate(alias, boundary, add) {
  if (!boundary || !Array.isArray(boundary.coordinates)) return null;
  if (boundary.type === 'Polygon') {
    return onePolygonPredicate(alias, boundary.coordinates, add);
  }
  if (boundary.type === 'MultiPolygon') {
    const polygons = boundary.coordinates
      .map((coordinates) => onePolygonPredicate(alias, coordinates, add))
      .filter(Boolean);
    return polygons.length ? `(${polygons.join(' OR ')})` : null;
  }
  return null;
}

/**
 * Exact spherical bounding box for a station-radius cap. This is only a cheap
 * prefilter: Haversine below remains the authoritative membership predicate.
 * Because the bounds are a superset of the circle they can safely use the
 * `(country, city, lat, lng)` read-model index without dropping edge matches.
 */
function stationRadiusBounds(station, maxM) {
  const lat = finite(station?.center?.lat);
  const lng = finite(station?.center?.lng);
  const distanceM = finite(maxM);
  if (lat == null || lng == null || distanceM == null || distanceM <= 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const angular = distanceM / EARTH_RADIUS_M;
  // A radius at least half the Earth's circumference has no useful bbox.
  if (!Number.isFinite(angular) || angular >= Math.PI) return null;

  const latRad = lat * DEG_TO_RAD;
  const minLatRad = Math.max(-Math.PI / 2, latRad - angular);
  const maxLatRad = Math.min(Math.PI / 2, latRad + angular);
  const bounds = {
    minLat: minLatRad * RAD_TO_DEG,
    maxLat: maxLatRad * RAD_TO_DEG,
    minLng: -180,
    maxLng: 180,
    wrapsLongitude: false,
    fullLongitude: false,
  };

  // Any circle touching a pole contains every longitude at that end of the
  // latitude band, so longitude cannot safely narrow the candidate set.
  if (minLatRad <= -Math.PI / 2 || maxLatRad >= Math.PI / 2) {
    bounds.fullLongitude = true;
    return bounds;
  }

  const denominator = Math.cos(latRad);
  const ratio = Math.sin(angular) / denominator;
  if (!Number.isFinite(ratio) || Math.abs(ratio) >= 1) {
    bounds.fullLongitude = true;
    return bounds;
  }

  const deltaLng = Math.asin(Math.abs(ratio)) * RAD_TO_DEG;
  bounds.minLng = normalizeLongitude(lng - deltaLng);
  bounds.maxLng = normalizeLongitude(lng + deltaLng);
  bounds.wrapsLongitude = bounds.minLng > bounds.maxLng;
  return bounds;
}

function stationRadiusBboxSql(alias, station, maxM, add) {
  const bounds = stationRadiusBounds(station, maxM);
  if (!bounds) return null;

  const clauses = [
    `${alias}.lat BETWEEN ${add(bounds.minLat)} AND ${add(bounds.maxLat)}`,
  ];
  if (!bounds.fullLongitude) {
    if (bounds.wrapsLongitude) {
      clauses.push(`(${alias}.lng >= ${add(bounds.minLng)} OR ${alias}.lng <= ${add(bounds.maxLng)})`);
    } else {
      clauses.push(`${alias}.lng BETWEEN ${add(bounds.minLng)} AND ${add(bounds.maxLng)}`);
    }
  }
  return `(${clauses.join(' AND ')})`;
}

function distanceSql(alias, station, add) {
  const lat = add(Number(station.center.lat));
  const lng = add(Number(station.center.lng));
  return `${EARTH_RADIUS_M} * ACOS(LEAST(1, GREATEST(-1,
    COS(RADIANS(${lat})) * COS(RADIANS(${alias}.lat)) * COS(RADIANS(${alias}.lng) - RADIANS(${lng}))
    + SIN(RADIANS(${lat})) * SIN(RADIANS(${alias}.lat)))))`;
}

function bearingSql(alias, station, add) {
  const lat = add(Number(station.center.lat));
  const lng = add(Number(station.center.lng));
  const raw = `DEGREES(ATAN2(
    SIN(RADIANS(${alias}.lng) - RADIANS(${lng})) * COS(RADIANS(${alias}.lat)),
    COS(RADIANS(${lat})) * SIN(RADIANS(${alias}.lat))
      - SIN(RADIANS(${lat})) * COS(RADIANS(${alias}.lat))
        * COS(RADIANS(${alias}.lng) - RADIANS(${lng}))
  ))`;
  return `(CASE WHEN ${raw} < 0 THEN ${raw} + 360 ELSE ${raw} END)`;
}

function arcFromFilters(filters) {
  const source = filters?.metroArc;
  if (!source || typeof source !== 'object') return null;
  const from = normalizedBearing(source.from);
  const to = normalizedBearing(source.to);
  if (from == null || to == null) return null;
  // The client treats coincident handles as a full circle, not an empty wedge.
  if (Math.abs(from - to) < 1e-9) return null;
  return {from, to};
}

function stationSpatialPredicate(alias, station, filters, add) {
  const clauses = [usableCoordinateSql(alias)];
  const maxM = finite(filters?.metroMaxM);
  if (maxM != null && maxM > 0) {
    const bbox = stationRadiusBboxSql(alias, station, maxM, add);
    if (bbox) clauses.push(bbox);
    clauses.push(`${distanceSql(alias, station, add)} <= ${add(maxM)}`);
  }
  const arc = arcFromFilters(filters);
  if (arc) {
    const bearing = bearingSql(alias, station, add);
    clauses.push(arc.from <= arc.to
      ? `${bearing} BETWEEN ${add(arc.from)} AND ${add(arc.to)}`
      : `(${bearing} >= ${add(arc.from)} OR ${bearing} <= ${add(arc.to)})`);
  }
  return `(${clauses.join(' AND ')})`;
}

function appendDistrictWhere({where, filters, alias, add, geometry}) {
  if (!filters?.district) return;
  const canonical = geometry?.district?.canonicalName || String(filters.district).trim();
  const boundary = boundaryPredicate(alias, geometry?.district?.boundary, add);
  if (!boundary) {
    where.push(`LOWER(${alias}.district) = ${add(canonical.toLocaleLowerCase())}`);
    return;
  }

  const usable = usableCoordinateSql(alias);
  const fallback = `LOWER(${alias}.district) = ${add(canonical.toLocaleLowerCase())}`;
  // Coordinates outrank text. A row with a valid final point must satisfy the
  // canonical administrative polygon even if its source text says otherwise.
  // Name fallback exists only for rows that genuinely have no usable point.
  where.push(`(((${usable}) AND ${boundary}) OR ((NOT (${usable})) AND ${fallback}))`);
}

function appendMetroWhere({where, filters, alias, add, geometry}) {
  const names = metroNames(filters);
  if (!names.length) return;

  const maxM = finite(filters?.metroMaxM);
  const arc = arcFromFilters(filters);
  const hasSpatialConstraint = (maxM != null && maxM > 0) || arc != null;

  if (!hasSpatialConstraint) {
    where.push(`LOWER(${alias}.metro) = ANY(${add(names.map((name) => name.toLocaleLowerCase()))}::text[])`);
    return;
  }

  const resolved = geometry?.metros || [];
  const conditions = resolved.map((station) => stationSpatialPredicate(alias, station, filters, add));

  // A legacy/unresolved station can preserve the old name+nearest-distance
  // fallback only when no directional wedge was requested. We cannot safely
  // invent a bearing without a canonical station coordinate. Include both the
  // caller's alias and the canonical name in the resolved set because the HTTP
  // boundary canonicalizes filters after resolution.
  const resolvedNames = new Set(
    resolved.flatMap((station) => [station.requested, station.canonicalName])
      .map((name) => String(name || '').trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const unresolved = names.filter((name) => !resolvedNames.has(name.toLocaleLowerCase()));
  if (!arc && unresolved.length) {
    const namePredicate = `LOWER(${alias}.metro) = ANY(${add(unresolved.map((name) => name.toLocaleLowerCase()))}::text[])`;
    if (maxM != null && maxM > 0) {
      conditions.push(`(${namePredicate} AND ${alias}.metro_distance_m <= ${add(maxM)})`);
    } else {
      conditions.push(namePredicate);
    }
  }

  // A requested geometric constraint with no resolvable station must fail
  // closed. Returning unrelated rows is worse than an empty result and hides a
  // geo-catalog/lexicon coverage gap.
  where.push(conditions.length ? `(${conditions.join(' OR ')})` : 'FALSE');
}

/**
 * Append database-owned district/metro membership predicates. Call this from
 * every SQL read model that serves public listing membership.
 */
export function appendPostgresGeoFilters({where, filters, alias, add}) {
  const geometry = resolvedSearchGeometry(filters);
  appendDistrictWhere({where, filters, alias, add, geometry});
  appendMetroWhere({where, filters, alias, add, geometry});
}

export const __postgresGeoFilterTest = {
  metroNames,
  ringPolygonText,
  boundaryPredicate,
  arcFromFilters,
  stationRadiusBounds,
  stationRadiusBboxSql,
  stationSpatialPredicate,
};
