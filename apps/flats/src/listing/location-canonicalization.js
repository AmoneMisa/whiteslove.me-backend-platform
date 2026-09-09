import {
  canonicalCity,
  canonicalRegion,
  locationCities,
  normalizeForMatch,
} from '@whiteslove/parsing-lexicon';
import {
  getGeoEntity,
  resolveLexiconGeoEntity,
} from '@whiteslove/geo-catalog';

const TYPE_TO_LIST_KEYS = Object.freeze({
  district: ['districts'],
  microdistrict: ['microdistricts'],
  mahalla: ['mahallas'],
  local_area: ['localAreas'],
  suburb: ['suburbs'],
  settlement: ['settlements'],
  informal_area: ['informalAreas'],
  development_area: ['developmentAreas'],
  residential_complex: ['residentialComplexes'],
  metro: ['metro'],
  street: ['streets'],
  poi: ['landmarks', 'pois'],
  search_cluster: ['searchClusters'],
});

const GENERIC_AREA_TYPES = Object.freeze([
  'local_area',
  'microdistrict',
  'mahalla',
  'development_area',
  'search_cluster',
]);
const GENERIC_LOCALITY_TYPES = Object.freeze(['suburb', 'settlement', 'local_area']);
const GENERIC_NEARBY_TYPES = Object.freeze(['poi', 'metro', 'local_area', 'microdistrict']);

const SOURCE_RESTORE_KEYS = Object.freeze([
  'country',
  'city',
  'region',
  'district',
  'area',
  'kvartal',
  'metro',
  'residenceComplex',
  'microdistrict',
  'street',
  'locality',
  'mahallas',
  'localAreas',
  'suburbs',
  'settlements',
  'informalAreas',
  'developmentAreas',
  'searchClusters',
  'nearby',
  'locationEntities',
  'locationCanonical',
]);

function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function normalizedType(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('poi.')) return 'poi';
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function countryCode(value) {
  return String(value || '').trim().toUpperCase();
}

function cityEntries(country, city) {
  const cities = locationCities(country);
  const canonical = text(city) ? (canonicalCity(city, country) || text(city)) : null;
  if (canonical && cities?.[canonical]) return [[canonical, cities[canonical]]];
  return Object.entries(cities || {});
}

function entryAliases(entry) {
  return [...new Set([
    entry?.canonical,
    entry?.name,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
  ].filter(Boolean))];
}

function exactAliasMatch(entry, value) {
  const needle = normalizeForMatch(value);
  if (!needle) return false;
  return entryAliases(entry).some((alias) => normalizeForMatch(alias) === needle);
}

function dictionaryCanonicalCandidates(value, country, city, types = null) {
  const wantedTypes = Array.isArray(types) ? types.map(normalizedType).filter(Boolean) : null;
  const keys = wantedTypes
    ? [...new Set(wantedTypes.flatMap((type) => TYPE_TO_LIST_KEYS[type] || []))]
    : [...new Set(Object.values(TYPE_TO_LIST_KEYS).flat())];
  const matches = [];

  for (const [cityName, data] of cityEntries(country, city)) {
    for (const key of keys) {
      for (const entry of data?.[key] || []) {
        if (!exactAliasMatch(entry, value)) continue;
        const canonical = text(entry.canonical || entry.name);
        if (!canonical) continue;
        matches.push({
          canonical,
          city: cityName,
          key,
          entry,
        });
      }
    }
  }

  return matches;
}

function uniqueCanonical(matches) {
  const names = [...new Set((matches || []).map((item) => item.canonical).filter(Boolean))];
  return names.length === 1 ? names[0] : null;
}

function geoTypeSupported(type) {
  return [
    'district',
    'microdistrict',
    'mahalla',
    'local_area',
    'suburb',
    'settlement',
    'residential_complex',
    'metro',
    'street',
    'poi',
  ].includes(type);
}

function geoTypeCompatible(requestedType, actualType) {
  const requested = normalizedType(requestedType);
  const actual = normalizedType(actualType);
  return Boolean(requested && actual && requested === actual);
}

function resolveGeo(country, city, type, canonical) {
  if (!geoTypeSupported(type) || !country || !city || !canonical) return null;
  return resolveLexiconGeoEntity({
    country,
    city,
    type,
    canonical,
  });
}

function resolveCompatibleGeo(country, city, type, canonical) {
  const geo = resolveGeo(country, city, type, canonical);
  return geo && geoTypeCompatible(type, geo.type) ? geo : null;
}

function typedCanonical(value, country, city, type) {
  const raw = text(value);
  const normalized = normalizedType(type);
  if (!raw || !normalized) return raw;

  const directGeo = resolveCompatibleGeo(country, city, normalized, raw);
  if (directGeo?.canonicalName) return directGeo.canonicalName;

  const typed = uniqueCanonical(dictionaryCanonicalCandidates(raw, country, city, [normalized]));
  if (typed) {
    const geo = resolveCompatibleGeo(country, city, normalized, typed);
    return geo?.canonicalName || typed;
  }

  // A lexical spelling can legitimately be registered under another semantic
  // collection while geo-catalog owns the same name under the requested type.
  // Example: "Янги Сергели" is a local-area alias, while the listing field is
  // explicitly residential_complex. Reuse only a candidate that geo-catalog
  // independently proves under the requested type and returns that exact type.
  if (geoTypeSupported(normalized)) {
    const crossType = dictionaryCanonicalCandidates(raw, country, city);
    const proved = [];
    for (const candidate of crossType) {
      const geo = resolveCompatibleGeo(country, candidate.city || city, normalized, candidate.canonical);
      if (geo?.canonicalName) proved.push(geo.canonicalName);
    }
    const canonical = [...new Set(proved)];
    if (canonical.length === 1) return canonical[0];
  }

  return raw;
}

function genericCanonical(value, country, city, types) {
  const raw = text(value);
  if (!raw) return raw;
  const matches = dictionaryCanonicalCandidates(raw, country, city, types);
  return uniqueCanonical(matches) || raw;
}

function sourceKey(key) {
  return `source${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function restoreSourceAuditValues(target) {
  for (const key of SOURCE_RESTORE_KEYS) {
    const source = sourceKey(key);
    if (!Object.hasOwn(target, source) || target[source] == null) continue;
    target[key] = Array.isArray(target[source]) ? [...target[source]] : target[source];
  }
}

function assignScalar(target, key, value) {
  const current = target[key];
  if (value == null || value === current) return;
  const source = sourceKey(key);
  if (target[source] == null && current != null && String(current).trim()) target[source] = current;
  target[key] = value;
}

function canonicalizeArray(values, canonicalize) {
  if (!Array.isArray(values)) return values;
  return [...new Set(values
    .map((value) => canonicalize(value))
    .filter((value) => value != null && String(value).trim()))];
}

function assignArray(target, key, canonical) {
  if (!Array.isArray(target[key])) return;
  const current = target[key];
  if (JSON.stringify(current) === JSON.stringify(canonical)) return;
  const source = sourceKey(key);
  if (target[source] == null) target[source] = [...current];
  target[key] = canonical;
}

function canonicalizeLocationEntities(values, country, city) {
  if (!Array.isArray(values)) return values;
  return values.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const type = normalizedType(item.type);
    const rawName = text(item.name);
    if (!type || !rawName) return item;
    const name = typedCanonical(rawName, country, city, type);
    const next = name === rawName ? { ...item } : { ...item, sourceName: item.sourceName || rawName, name };
    const geo = resolveCompatibleGeo(country, city, type, name);
    if (geo?.id && !next.geoEntityId) next.geoEntityId = geo.id;
    if (next.geoEntityId) {
      const existing = getGeoEntity(next.geoEntityId);
      if (existing && !geoTypeCompatible(type, existing.type)) delete next.geoEntityId;
    }
    return next;
  });
}

/**
 * Final persistence-boundary canonicalization for Listing geography.
 *
 * Vocabulary stays owned by @whiteslove/parsing-lexicon and typed physical
 * identity stays owned by @whiteslove/geo-catalog. This function only enforces
 * that recognized aliases cannot leak into PostgreSQL/Elasticsearch as a
 * second spelling of the same semantic entity. Unknown values are preserved
 * rather than guessed, and changed source spellings remain available under
 * source* audit fields.
 *
 * preferSourceAudit is intended for repair/backfill runs. It replays the
 * original source spellings through the current canonicalizer so a previous
 * buggy canonicalization can be corrected idempotently without guessing.
 */
export function canonicalizeListingLocations(input, { preferSourceAudit = false } = {}) {
  const target = { ...(input || {}) };
  if (preferSourceAudit) restoreSourceAuditValues(target);

  const country = countryCode(target.country);
  if (country && country !== target.country) {
    if (target.sourceCountry == null && target.country != null) target.sourceCountry = target.country;
    target.country = country;
  }

  const rawCity = text(target.city);
  const canonicalListingCity = rawCity ? (canonicalCity(rawCity, country) || rawCity) : rawCity;
  assignScalar(target, 'city', canonicalListingCity);
  const city = text(target.city);

  const rawRegion = text(target.region);
  if (rawRegion) assignScalar(target, 'region', canonicalRegion(rawRegion, country) || rawRegion);

  const scalarTypes = [
    ['district', 'district'],
    ['microdistrict', 'microdistrict'],
    ['metro', 'metro'],
    ['residenceComplex', 'residential_complex'],
    ['street', 'street'],
  ];
  for (const [key, type] of scalarTypes) {
    if (target[key] == null) continue;
    assignScalar(target, key, typedCanonical(target[key], country, city, type));
  }

  if (target.area != null) assignScalar(target, 'area', genericCanonical(target.area, country, city, GENERIC_AREA_TYPES));
  if (target.kvartal != null) assignScalar(target, 'kvartal', genericCanonical(target.kvartal, country, city, GENERIC_AREA_TYPES));
  if (target.locality != null) assignScalar(target, 'locality', genericCanonical(target.locality, country, city, GENERIC_LOCALITY_TYPES));

  const typedArrays = [
    ['mahallas', 'mahalla'],
    ['localAreas', 'local_area'],
    ['suburbs', 'suburb'],
    ['settlements', 'settlement'],
    ['informalAreas', 'informal_area'],
    ['developmentAreas', 'development_area'],
    ['searchClusters', 'search_cluster'],
  ];
  for (const [key, type] of typedArrays) {
    if (!Array.isArray(target[key])) continue;
    assignArray(target, key, canonicalizeArray(
      target[key],
      (value) => typedCanonical(value, country, city, type),
    ));
  }

  if (Array.isArray(target.nearby)) {
    assignArray(target, 'nearby', canonicalizeArray(
      target.nearby,
      (value) => genericCanonical(value, country, city, GENERIC_NEARBY_TYPES),
    ));
  }

  if (Array.isArray(target.locationEntities)) {
    const canonicalEntities = canonicalizeLocationEntities(target.locationEntities, country, city);
    if (JSON.stringify(target.locationEntities) !== JSON.stringify(canonicalEntities)) {
      if (target.sourceLocationEntities == null) target.sourceLocationEntities = target.locationEntities.map((item) => (
        item && typeof item === 'object' && !Array.isArray(item) ? { ...item } : item
      ));
      target.locationEntities = canonicalEntities;
    }
  }

  if (target.locationGeoEntityId) {
    const entity = getGeoEntity(target.locationGeoEntityId);
    if (entity?.canonicalName) assignScalar(target, 'locationCanonical', entity.canonicalName);
  }

  return target;
}
