import {resolveLexiconGeoEntity} from '@whiteslove/geo-catalog';
import {matchDictionaryEntities} from './location-dictionary-resolver.js';

const SEARCH_GEOMETRY_KEY = '_resolvedSearchGeometry';

function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = text(value);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function canonicalFromDictionary(type, value, country, city) {
  if (!value) return null;
  const probe = type === 'metro' ? `metro ${value}` : value;
  const matched = matchDictionaryEntities(probe, country, city);
  return type === 'metro' ? text(matched.metro) : text(matched.district);
}

function resolveEntity(type, value, country, city) {
  const requested = text(value);
  if (!requested || !country || !city) return null;

  let entity = resolveLexiconGeoEntity({
    country,
    city,
    type,
    canonical: requested,
  });
  if (entity) return entity;

  const canonical = canonicalFromDictionary(type, requested, country, city);
  if (!canonical) return null;
  entity = resolveLexiconGeoEntity({
    country,
    city,
    type,
    canonical,
  });
  return entity || null;
}

function snapshotEntity(entity) {
  if (!entity) return null;
  return {
    id: entity.id,
    type: entity.type,
    canonicalName: entity.canonicalName,
    center: entity.center ? {lat: entity.center.lat, lng: entity.center.lng} : null,
    bbox: entity.bbox ? {...entity.bbox} : null,
    boundary: entity.boundary || null,
  };
}

/**
 * Resolve user-facing district/metro filter names to canonical geo-catalog
 * entities once at the HTTP boundary. The result is intentionally attached as
 * a non-enumerable property: SQL builders can consume it, but API responses do
 * not accidentally serialize whole district polygons back to clients.
 */
export function attachResolvedSearchGeometry(filters, countryCodes) {
  if (!filters || typeof filters !== 'object') return null;
  const codes = unique((countryCodes || []).map((value) => String(value).toUpperCase()));
  const country = codes.length === 1 ? codes[0] : null;
  const city = text(filters.city);

  const requestedMetros = unique(
    Array.isArray(filters.metros)
      ? filters.metros
      : String(filters.metro || '').split(','),
  );

  let district = null;
  const metros = [];
  const unresolvedMetros = [];

  if (country && city) {
    district = snapshotEntity(resolveEntity('district', filters.district, country, city));
    for (const requested of requestedMetros) {
      const entity = snapshotEntity(resolveEntity('metro', requested, country, city));
      if (entity?.center && Number.isFinite(entity.center.lat) && Number.isFinite(entity.center.lng)) {
        metros.push({...entity, requested});
      } else {
        unresolvedMetros.push(requested);
      }
    }
  } else {
    unresolvedMetros.push(...requestedMetros);
  }

  if (district?.canonicalName) filters.district = district.canonicalName;
  if (requestedMetros.length) {
    const resolvedByRequested = new Map(metros.map((item) => [item.requested.toLocaleLowerCase(), item.canonicalName]));
    filters.metros = requestedMetros.map((requested) =>
      resolvedByRequested.get(requested.toLocaleLowerCase()) || requested,
    );
    filters.metro = filters.metros.join(',');
  } else {
    filters.metros = [];
    filters.metro = '';
  }

  const geometry = Object.freeze({
    country,
    city,
    district,
    metros: Object.freeze(metros),
    unresolvedMetros: Object.freeze(unresolvedMetros),
  });
  Object.defineProperty(filters, SEARCH_GEOMETRY_KEY, {
    value: geometry,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return geometry;
}

export function resolvedSearchGeometry(filters) {
  return filters?.[SEARCH_GEOMETRY_KEY] || null;
}

/** Preserve non-enumerable request geometry across internal `{...filters}` copies. */
export function copyResolvedSearchGeometry(source, target) {
  const geometry = resolvedSearchGeometry(source);
  if (!geometry || !target || typeof target !== 'object') return target;
  Object.defineProperty(target, SEARCH_GEOMETRY_KEY, {
    value: geometry,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return target;
}

export const __searchFilterGeometryTest = {
  resolveEntity,
  canonicalFromDictionary,
};
