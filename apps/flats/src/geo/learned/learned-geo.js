import { buildGeoLookupKey, getGeoEntityByLookupKey } from '@whiteslove/geo-catalog';
import {pool} from '../../infrastructure/database/pool.js';

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

function canonicalForSource(listing, source, candidate) {
  if (source === 'street') return text(listing.street) || text(candidate?.name);
  if (source === 'residentialComplex') return text(listing.residenceComplex) || text(candidate?.name);
  if (source === 'metro') return text(listing.metro) || text(candidate?.name);
  if (source === 'microdistrict') return text(listing.microdistrict) || text(candidate?.name);
  if (source === 'localArea' || source === 'area') return text(candidate?.name) || text(listing.area) || text(listing.kvartal);
  if (source === 'district') return text(listing.district) || text(candidate?.name);
  return text(candidate?.name);
}

export function learnedGeoDescriptor(listing, country, candidate) {
  const source = candidate?.source;
  const type = TYPE_BY_SOURCE[source];
  const countryCode = String(country?.code || listing?.country || '').toUpperCase();
  if (!type || !countryCode) return null;

  const base = {
    country: countryCode,
    type,
    region: text(listing?.region),
    city: text(listing?.city),
    district: text(listing?.district),
    street: text(listing?.street),
    houseNumber: text(listing?.houseNumber),
    building: text(listing?.building),
    canonical: canonicalForSource(listing, source, candidate),
  };

  if (type === 'address' && (!base.street || !base.houseNumber)) return null;
  if (type !== 'address' && !base.canonical) return null;

  const lookupKey = buildGeoLookupKey(base);
  if (!lookupKey) return null;

  const canonicalName = type === 'address'
    ? [base.street, base.houseNumber, base.building ? `корп. ${base.building}` : null].filter(Boolean).join(' ')
    : base.canonical;

  return Object.freeze({
    ...base,
    lookupKey,
    canonicalName,
    queryText: text(candidate?.q) || canonicalName,
    accuracyM: finiteAccuracy(candidate?.accuracyM, DEFAULT_ACCURACY_M[type] ?? null),
  });
}

export async function findLearnedGeo(descriptor) {
  if (!descriptor?.lookupKey) return null;

  const packaged = getGeoEntityByLookupKey(descriptor.lookupKey);
  if (packaged?.center && Number.isFinite(packaged.center.lat) && Number.isFinite(packaged.center.lng)) {
    return {
      lat: packaged.center.lat,
      lng: packaged.center.lng,
      accuracyM: finiteAccuracy(packaged.accuracyM, descriptor.accuracyM),
      precision: descriptor.type === 'address' ? 'building' : null,
      source: 'geoCatalogLearned',
      provider: 'geoCatalog',
      lookupKey: descriptor.lookupKey,
    };
  }

  const result = await pool.query(
    `SELECT lat, lng, accuracy_m, provider, provider_id, provider_type
       FROM learned_geo
      WHERE lookup_key = $1
      LIMIT 1`,
    [descriptor.lookupKey],
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
    lookupKey: descriptor.lookupKey,
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
      descriptor.lookupKey,
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
