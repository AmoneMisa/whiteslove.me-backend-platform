import { buildGeoLookupKey, getGeoEntityByLookupKey } from '@whiteslove/geo-catalog';
import {pool} from '../../infrastructure/database/pool.js';
import { canonicalCityName } from '../countries.js';

const TYPE_BY_SOURCE = Object.freeze({
  address: 'address',
  street: 'street',
  residentialComplex: 'residential_complex',
  poi: 'poi',
  metro: 'metro',
  microdistrict: 'microdistrict',
  localArea: 'local_area',
  area: 'local_area',
  suburb: 'suburb',
  settlement: 'settlement',
  district: 'district',
});

const DEFAULT_ACCURACY_M = Object.freeze({
  address: null,
  street: 180,
  residential_complex: 300,
  poi: 700,
  metro: 250,
  microdistrict: 600,
  local_area: 800,
  suburb: 1400,
  settlement: 1400,
  district: 2500,
});

const STREET_IDENTITY_NOISE_RE = /(?<![\p{L}\p{N}])(?:street|st|strada|str|road|rd|avenue|ave|улица|ул|вулиця|вул|kocha|kochasi|кўча|көше)(?![\p{L}\p{N}])/giu;
const RESIDENTIAL_IDENTITY_NOISE_RE = /(?<![\p{L}\p{N}])(?:жк|жилой\s+комплекс|житловий\s+комплекс|residential\s+complex|turar\s+joy\s+majmuasi)(?![\p{L}\p{N}])/giu;
const METRO_IDENTITY_NOISE_RE = /(?<![\p{L}\p{N}])(?:metro|метро|станция|станція|station)(?![\p{L}\p{N}])/giu;
const BUILDING_IDENTITY_PREFIX_RE = /^(?:корп(?:ус)?\.?|building|bldg\.?|bloc|corp|korpus)\s*/iu;

function text(value) {
  const out = String(value ?? '').trim();
  return out || null;
}

function boundedText(value, maxLength) {
  const out = text(value);
  return out ? out.slice(0, maxLength) : null;
}

function finiteAccuracy(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function trustedExactAddressProviderType(value) {
  return String(value || '').startsWith('validated-address:');
}

function identityText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[’‘ʻʼ`´]/gu, "'")
    .replace(/[‐‑‒–—―]/gu, '-')
    .replace(/[^\p{L}\p{N}'/-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function identityNumber(value, { building = false } = {}) {
  let normalized = String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim();
  if (building) normalized = normalized.replace(BUILDING_IDENTITY_PREFIX_RE, '');
  return normalized
    // NFKC expands `№12` to `No12`, so strip both the original sign and its
    // normalized ASCII form before building the persistent semantic identity.
    .replace(/^(?:№|#|no\.?)\s*/iu, '')
    .replace(/[№#\s]/gu, '')
    .replace(/[‐‑‒–—―]/gu, '-')
    .replace(/[^\p{L}\p{N}/-]+/gu, '');
}

function identityStreet(value) {
  return identityText(value)
    .replace(STREET_IDENTITY_NOISE_RE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function identityCanonical(type, value) {
  const normalized = identityText(value);
  if (!normalized) return normalized;
  if (type === 'street') return identityStreet(normalized);
  if (type === 'residential_complex') {
    const withoutType = normalized
      .replace(RESIDENTIAL_IDENTITY_NOISE_RE, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return withoutType || normalized;
  }
  if (type === 'metro') {
    const withoutType = normalized
      .replace(METRO_IDENTITY_NOISE_RE, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return withoutType || normalized;
  }
  return normalized;
}

function canonicalForSource(listing, source, candidate) {
  if (source === 'street') return text(listing.street) || text(candidate?.name);
  if (source === 'residentialComplex') return text(listing.residenceComplex) || text(candidate?.name);
  if (source === 'metro') return text(listing.metro) || text(candidate?.name);
  if (source === 'microdistrict') return text(listing.microdistrict) || text(candidate?.name);
  if (source === 'localArea' || source === 'area') return text(candidate?.name) || text(listing.area) || text(listing.kvartal);
  if (source === 'district') return text(listing.district) || text(candidate?.name);
  return text(candidate?.name);
}

function descriptorLookupKeys(base, rawCity) {
  const primaryParts = {
    ...base,
    city: canonicalCityName(base.country, base.city) || base.city,
    street: base.type === 'address' ? identityStreet(base.street) : base.street,
    houseNumber: base.type === 'address' ? identityNumber(base.houseNumber) : base.houseNumber,
    building: base.type === 'address' ? identityNumber(base.building, { building: true }) : base.building,
    canonical: base.type === 'address' ? base.canonical : identityCanonical(base.type, base.canonical),
  };
  const canonicalCityRawIdentity = {
    ...base,
    city: primaryParts.city,
  };
  const rawIdentity = {
    ...base,
    city: rawCity,
  };

  return [...new Set([
    buildGeoLookupKey(primaryParts),
    buildGeoLookupKey(canonicalCityRawIdentity),
    buildGeoLookupKey(rawIdentity),
  ].filter(Boolean))];
}

export function learnedGeoDescriptor(listing, country, candidate) {
  const source = candidate?.source;
  const type = TYPE_BY_SOURCE[source];
  const countryCode = String(country?.code || listing?.country || '').toUpperCase();
  if (!type || !countryCode) return null;

  const rawCity = text(listing?.city);
  const base = {
    country: countryCode,
    type,
    region: text(listing?.region),
    city: canonicalCityName(countryCode, rawCity) || rawCity,
    district: text(listing?.district),
    street: text(listing?.street),
    houseNumber: text(listing?.houseNumber),
    building: text(listing?.building),
    canonical: canonicalForSource(listing, source, candidate),
  };

  if (type === 'address' && (!base.street || !base.houseNumber)) return null;
  if (type !== 'address' && !base.canonical) return null;

  const lookupKeys = descriptorLookupKeys(base, rawCity);
  const lookupKey = lookupKeys[0];
  if (!lookupKey) return null;

  const canonicalName = type === 'address'
    ? [base.street, base.houseNumber, base.building ? `корп. ${base.building}` : null].filter(Boolean).join(' ')
    : base.canonical;

  return Object.freeze({
    ...base,
    lookupKey,
    lookupKeys: Object.freeze(lookupKeys),
    canonicalName,
    queryText: text(candidate?.q) || canonicalName,
    accuracyM: finiteAccuracy(candidate?.accuracyM, DEFAULT_ACCURACY_M[type] ?? null),
  });
}

export async function findLearnedGeo(descriptor) {
  if (!descriptor?.lookupKey) return null;
  const lookupKeys = descriptor.lookupKeys?.length ? descriptor.lookupKeys : [descriptor.lookupKey];

  for (const lookupKey of lookupKeys) {
    const packaged = getGeoEntityByLookupKey(lookupKey);
    if (packaged?.center && Number.isFinite(packaged.center.lat) && Number.isFinite(packaged.center.lng)) {
      return {
        lat: packaged.center.lat,
        lng: packaged.center.lng,
        accuracyM: finiteAccuracy(packaged.accuracyM, descriptor.accuracyM),
        precision: descriptor.type === 'address' ? 'building' : null,
        source: 'geoCatalogLearned',
        provider: 'geoCatalog',
        lookupKey,
      };
    }
  }

  const result = await pool.query(
    `SELECT lookup_key, lat, lng, accuracy_m, provider, provider_id, provider_type
       FROM learned_geo
      WHERE lookup_key = ANY($1::text[])
      ORDER BY array_position($1::text[], lookup_key)
      LIMIT 1`,
    [lookupKeys],
  );
  const row = result.rows[0];
  if (!row) return null;

  if (descriptor.type === 'address' && !trustedExactAddressProviderType(row.provider_type)) {
    return null;
  }

  return {
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracyM: finiteAccuracy(row.accuracy_m, descriptor.accuracyM),
    precision: descriptor.type === 'address' ? 'building' : null,
    source: 'learnedDb',
    provider: row.provider || 'learned',
    providerId: row.provider_id || null,
    providerType: row.provider_type || null,
    lookupKey: row.lookup_key,
  };
}

export async function rememberLearnedGeo(descriptor, coords, provider = {}) {
  if (!descriptor?.lookupKey || !Number.isFinite(coords?.lat) || !Number.isFinite(coords?.lng)) return false;

  const providerName = boundedText(provider.name || coords.provider, 32) || 'nominatim';
  const providerId = text(provider.id || coords.providerId);
  const rawProviderType = provider.type || coords.providerType;
  const providerType = descriptor.type === 'address' && coords.precision === 'building'
    ? `validated-address:${rawProviderType || 'building'}`
    : rawProviderType;
  const accuracyM = finiteAccuracy(coords.accuracyM, descriptor.accuracyM);
  const lookupKeys = descriptor.lookupKeys?.length ? descriptor.lookupKeys : [descriptor.lookupKey];

  // Reuse a legacy/raw key if that identity was learned before normalized keys
  // were introduced. This prevents a spelling/format normalization upgrade from
  // creating a second row for the same physical address/entity.
  const existing = await pool.query(
    `SELECT lookup_key
       FROM learned_geo
      WHERE lookup_key = ANY($1::text[])
      ORDER BY array_position($1::text[], lookup_key)
      LIMIT 1`,
    [lookupKeys],
  );
  const storageLookupKey = existing.rows[0]?.lookup_key || descriptor.lookupKey;

  const result = await pool.query(
    `INSERT INTO learned_geo (
       lookup_key, country, region, city, district, street, house_number, building,
       entity_type, canonical_name, query_text, lat, lng, accuracy_m,
       provider, provider_id, provider_type
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     )
     ON CONFLICT (lookup_key) DO UPDATE SET
       query_text = EXCLUDED.query_text,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       accuracy_m = EXCLUDED.accuracy_m,
       provider = EXCLUDED.provider,
       provider_id = EXCLUDED.provider_id,
       provider_type = EXCLUDED.provider_type,
       created_at = NOW(),
       exported_at = NULL`,
    [
      storageLookupKey,
      boundedText(descriptor.country, 8),
      boundedText(descriptor.region, 255),
      boundedText(descriptor.city, 255),
      boundedText(descriptor.district, 255),
      descriptor.street,
      boundedText(descriptor.houseNumber, 64),
      boundedText(descriptor.building, 128),
      boundedText(descriptor.type, 64),
      descriptor.canonicalName,
      descriptor.queryText,
      coords.lat,
      coords.lng,
      accuracyM,
      providerName,
      providerId,
      boundedText(providerType, 64),
    ],
  );
  return result.rowCount > 0;
}

export async function pendingLearnedGeo(limit = 1000) {
  const safeLimit = Math.max(1, Math.min(10_000, Math.trunc(Number(limit) || 1000)));
  const result = await pool.query(
    `SELECT lookup_key, country, region, city, district, street, house_number, building,
            entity_type, canonical_name, query_text, lat, lng, accuracy_m,
            provider, provider_id, provider_type, created_at
       FROM learned_geo
      WHERE exported_at IS NULL
      ORDER BY created_at ASC, lookup_key ASC
      LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}

export async function markLearnedGeoExported(lookupKeys) {
  const keys = [...new Set((lookupKeys || []).filter(Boolean))];
  if (!keys.length) return 0;
  const result = await pool.query(
    `UPDATE learned_geo
        SET exported_at = NOW()
      WHERE lookup_key = ANY($1::text[])
        AND exported_at IS NULL`,
    [keys],
  );
  return result.rowCount;
}
