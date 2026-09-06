import {pool} from '../database/pool.js';
import {appendPostgresGeoFilters} from './postgres-geo-filter.js';

function keyOf(row) {
  return `${row.source}:${String(row.country || '').toUpperCase()}:${row.source_id}`;
}

function hasGeoFilter(filters) {
  return Boolean(
    String(filters?.district || '').trim()
      || (Array.isArray(filters?.metros) ? filters.metros.length : String(filters?.metro || '').trim()),
  );
}

function normalizedMetroNames(filters) {
  const values = Array.isArray(filters?.metros)
    ? filters.metros
    : String(filters?.metro || '').split(',');
  return [...new Set(values
    .map((value) => String(value).trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve geographic membership in PostgreSQL before the normal search/count/
 * map query. The returned key set is joined by the existing authoritative
 * search path, so pagination, dedupe, count and map all consume exactly the
 * same geo membership and no client has to post-filter a page.
 *
 * This is deliberately a gate rather than a second in-memory filter: the
 * point-in-polygon / Haversine / bearing predicates execute against persisted
 * listing coordinates in PostgreSQL.
 */
export async function applyPostgresGeoGate({filters, countries, searchMatches = null}) {
  if (!hasGeoFilter(filters)) return searchMatches;

  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [];
  const countryValues = [...new Set((countries || [])
    .map((value) => String(value).toUpperCase())
    .filter(Boolean))];
  if (countryValues.length) {
    where.push(`l.country = ANY(${add(countryValues)}::text[])`);
  }
  if (filters.city) {
    where.push(`l.city = ${add(String(filters.city))}`);
  }
  appendPostgresGeoFilters({where, filters, alias: 'l', add});
  if (!where.length) return searchMatches;

  const {rows} = await pool.query(`
    SELECT l.source, l.country, l.source_id
    FROM listings l
    WHERE ${where.join('\n      AND ')}
  `, params);
  const geoKeys = new Set(rows.map(keyOf));

  if (searchMatches != null) {
    const rank = new Map();
    for (const [key, value] of searchMatches.rank || []) {
      if (geoKeys.has(key)) rank.set(key, value);
    }
    return {
      ...searchMatches,
      rank,
      total: rank.size,
      geoFiltered: true,
    };
  }

  const rank = new Map();
  let index = 0;
  for (const key of geoKeys) rank.set(key, index++);
  return {
    rank,
    total: rank.size,
    truncated: false,
    geoFiltered: true,
  };
}

/**
 * The geo gate has already decided membership. Remove legacy string/nearest-
 * metro clauses before the downstream query so they cannot contradict the
 * coordinate-first decision or accidentally turn a multi-station CSV into one
 * station name.
 *
 * `geoScope` is deliberately retained as inert semantic metadata. The SQL core
 * ignores it, while postgres-cursor-scope includes it in the cursor hash. A
 * cursor issued for Novza/800m therefore cannot be reused for a different
 * district/station/radius/arc and skip into the wrong result set.
 */
export function withoutLegacyGeoFilters(filters) {
  if (!hasGeoFilter(filters)) return filters;
  const geoScope = {
    district: String(filters?.district || '').trim(),
    metros: normalizedMetroNames(filters),
    metroMaxM: filters?.metroMaxM ?? null,
    metroArc: filters?.metroArc == null
      ? null
      : {
          from: filters.metroArc.from ?? null,
          to: filters.metroArc.to ?? null,
        },
  };
  return {
    ...filters,
    geoScope,
    district: '',
    metro: '',
    metros: [],
    metroMaxM: null,
    metroArc: null,
  };
}

export const __postgresGeoGateTest = {hasGeoFilter, keyOf, normalizedMetroNames};
