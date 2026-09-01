import {
  canonicalKazakhstanCity,
  canonicalUkraineCity,
  canonicalUzbekistanCity,
} from '@whiteslove/parsing-lexicon';
import { resolveLexiconGeoEntity } from '@whiteslove/geo-catalog';

const CITY_CANONICALIZERS = Object.freeze({
  KZ: canonicalKazakhstanCity,
  UA: canonicalUkraineCity,
  UZ: canonicalUzbekistanCity,
});

const SOURCE_BY_TYPE = Object.freeze({
  residential_complex: 'residentialComplex',
  metro: 'metro',
  microdistrict: 'microdistrict',
  mahalla: 'localArea',
  local_area: 'localArea',
  suburb: 'suburb',
  settlement: 'settlement',
  district: 'district',
  city: 'city',
});

const DEFAULT_ACCURACY_M = Object.freeze({
  residential_complex: 300,
  metro: 250,
  microdistrict: 600,
  mahalla: 700,
  local_area: 800,
  suburb: 1400,
  settlement: 1400,
  district: 2500,
  city: 8000,
});

const BROAD_TYPE_PRIORITY = Object.freeze({
  microdistrict: 10,
  mahalla: 20,
  local_area: 30,
  suburb: 40,
  settlement: 40,
  district: 90,
});

function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function hasCoordinates(listing) {
  return listing?.lat != null
    && listing?.lng != null
    && Number.isFinite(Number(listing.lat))
    && Number.isFinite(Number(listing.lng));
}

export function canonicalGeoCatalogCity(countryCode, value) {
  const code = String(countryCode || '').toUpperCase();
  const canonicalizer = CITY_CANONICALIZERS[code];
  return canonicalizer?.(value) || text(value);
}

function entityType(value) {
  const type = String(value || '');
  if (type === 'residentialComplex' || type === 'residential_complex') return 'residential_complex';
  if (type === 'localArea' || type === 'local_area') return 'local_area';
  if (type.startsWith('poi.')) return 'poi';
  return type;
}

function resolve(countryCode, city, type, canonical) {
  const normalizedType = entityType(type);
  const name = text(canonical);
  // Streets/addresses remain external-geocoder responsibilities. POIs are not
  // used as direct placement anchors because listing text usually means “near”.
  if (!name || normalizedType === 'street' || normalizedType === 'poi') return null;
  return resolveLexiconGeoEntity({
    country: countryCode,
    city: normalizedType === 'city' ? undefined : city,
    type: normalizedType,
    canonical: name,
  });
}

function apply(listing, entity) {
  if (!entity?.center || !Number.isFinite(entity.center.lat) || !Number.isFinite(entity.center.lng)) return false;
  listing.lat = entity.center.lat;
  listing.lng = entity.center.lng;
  listing.locationSource = SOURCE_BY_TYPE[entity.type] || 'geoCatalog';
  listing.locationAccuracyM = entity.accuracyM ?? DEFAULT_ACCURACY_M[entity.type] ?? 1000;
  return true;
}

function canonicalContext(listing, country) {
  const countryCode = String(country?.code || '').toUpperCase();
  const city = canonicalGeoCatalogCity(countryCode, listing?.city || country?.cities?.[0] || '');
  if (city) listing.city = city;
  return { countryCode, city };
}

function uniqueInputs(inputs) {
  const seen = new Set();
  return inputs.filter((input) => {
    if (!input?.canonical || !input?.type) return false;
    const key = `${input.type}|${String(input.canonical).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function applyGeoCatalogExactAnchor(listing, country) {
  if (!listing || hasCoordinates(listing)) return false;
  const { countryCode, city } = canonicalContext(listing, country);
  if (!countryCode || !city) return false;

  const inputs = [
    { type: 'residential_complex', canonical: listing.residenceComplex },
    { type: 'metro', canonical: listing.metro },
    ...(Array.isArray(listing.locationEntities) ? listing.locationEntities : [])
      .map((entity) => ({ type: entityType(entity?.type), canonical: entity?.name }))
      .filter((input) => ['residential_complex', 'metro'].includes(input.type)),
  ];

  for (const input of uniqueInputs(inputs)) {
    const entity = resolve(countryCode, city, input.type, input.canonical);
    if (entity && apply(listing, entity)) return true;
  }
  return false;
}

export function applyGeoCatalogBroadAnchor(listing, country) {
  if (!listing || hasCoordinates(listing)) return false;
  const { countryCode, city } = canonicalContext(listing, country);
  if (!countryCode || !city) return false;

  const locationEntities = (Array.isArray(listing.locationEntities) ? listing.locationEntities : [])
    .map((entity) => ({ type: entityType(entity?.type), canonical: entity?.name }))
    .filter((input) => Object.hasOwn(BROAD_TYPE_PRIORITY, input.type))
    .sort((a, b) => BROAD_TYPE_PRIORITY[a.type] - BROAD_TYPE_PRIORITY[b.type]);

  const inputs = [
    { type: 'microdistrict', canonical: listing.microdistrict },
    ...locationEntities,
    { type: 'local_area', canonical: listing.area || listing.kvartal },
    ...(listing.localAreas || []).map((canonical) => ({ type: 'local_area', canonical })),
    ...(listing.suburbs || []).map((canonical) => ({ type: 'suburb', canonical })),
    ...(listing.settlements || []).map((canonical) => ({ type: 'settlement', canonical })),
    { type: 'district', canonical: listing.district },
  ];

  for (const input of uniqueInputs(inputs)) {
    const entity = resolve(countryCode, city, input.type, input.canonical);
    if (entity && apply(listing, entity)) return true;
  }
  return false;
}

export function applyGeoCatalogCityFallback(listing, country) {
  if (!listing || hasCoordinates(listing)) return false;
  const { countryCode, city } = canonicalContext(listing, country);
  if (!countryCode || !city) return false;
  const entity = resolve(countryCode, city, 'city', city);
  return Boolean(entity && apply(listing, entity));
}
