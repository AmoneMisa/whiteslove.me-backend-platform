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
  street: 'street',
  metro: 'metro',
  poi: 'poi',
  microdistrict: 'microdistrict',
  mahalla: 'localArea',
  local_area: 'localArea',
  suburb: 'suburb',
  settlement: 'settlement',
  district: 'district',
  city: 'city',
});

const PRECISION_BY_TYPE = Object.freeze({
  residential_complex: 'complex',
  street: 'street',
  metro: 'station',
  poi: 'reference',
  microdistrict: 'neighborhood',
  mahalla: 'neighborhood',
  local_area: 'neighborhood',
  suburb: 'locality',
  settlement: 'locality',
  district: 'district',
  city: 'city',
});

const DEFAULT_ACCURACY_M = Object.freeze({
  residential_complex: 300,
  street: 600,
  metro: 500,
  poi: 700,
  microdistrict: 600,
  mahalla: 700,
  local_area: 800,
  suburb: 1400,
  settlement: 1400,
  district: 2500,
  city: 8000,
});

// Required point-like precedence from GEO_ACCURACY_AUDIT.md:
// verified residential complex > verified PRIMARY POI > verified PRIMARY metro
// > directly stated bare street. Street+house is handled before this layer.
const EXACT_TYPE_PRIORITY = Object.freeze({
  residential_complex: 10,
  poi: 20,
  metro: 30,
  street: 40,
});

const BROAD_TYPE_PRIORITY = Object.freeze({
  microdistrict: 10,
  mahalla: 20,
  local_area: 30,
  suburb: 40,
  settlement: 40,
  district: 90,
});

const REFERENCE_TYPE_PRIORITY = Object.freeze({
  residential_complex: 10,
  poi: 20,
  metro: 30,
  street: 35,
  microdistrict: 40,
  mahalla: 50,
  local_area: 60,
  suburb: 70,
  settlement: 70,
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
  if (!name) return null;
  return resolveLexiconGeoEntity({
    country: countryCode,
    city: normalizedType === 'city' ? undefined : city,
    type: normalizedType,
    canonical: name,
  });
}

function normalizedRole(value) {
  return value === 'primary' || value === 'nearby' ? value : 'mentioned';
}

function roleFor(listing, type, canonical) {
  const normalizedType = entityType(type);
  const name = text(canonical)?.toLocaleLowerCase();
  if (!name) return 'mentioned';
  const match = (listing?.locationEntities || []).find((item) =>
    entityType(item?.type) === normalizedType
      && text(item?.name)?.toLocaleLowerCase() === name,
  );
  return normalizedRole(match?.role);
}

function apply(listing, entity, input = {}) {
  if (!entity?.center || !Number.isFinite(entity.center.lat) || !Number.isFinite(entity.center.lng)) return false;
  const role = normalizedRole(input.role);
  const intrinsicAccuracyM = entity.accuracyM ?? DEFAULT_ACCURACY_M[entity.type] ?? 1000;
  // A lower-context reference is useful, but it must never advertise the same
  // certainty as a primary property anchor merely because its canonical point
  // is exact. The uncertainty describes the property relative to the anchor.
  const relationshipAccuracyM = role === 'nearby' ? 900 : (role === 'mentioned' ? 1000 : 0);

  listing.lat = entity.center.lat;
  listing.lng = entity.center.lng;
  listing.locationSource = role === 'nearby' ? 'nearby' : (SOURCE_BY_TYPE[entity.type] || 'geoCatalog');
  listing.locationAccuracyM = Math.max(intrinsicAccuracyM, relationshipAccuracyM);
  listing.locationPrecision = PRECISION_BY_TYPE[entity.type] || 'reference';
  listing.locationApproximate = true;
  listing.locationCanonical = input.canonical || entity.canonicalName || null;
  listing.locationRole = role;
  listing.locationProvider = 'geoCatalog';
  listing.locationGeoEntityId = entity.id || null;
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

function exactInputAllowed(input) {
  if (!input || input.role === 'nearby') return false;
  if (input.type === 'poi' || input.type === 'metro') return input.role === 'primary';
  // A parser-promoted residenceComplex/street field is direct property-location
  // evidence even when the lexical entity has no explicit role. Entity-only
  // mentions, however, need `primary` to enter the exact tier.
  if (input.origin === 'field') return true;
  return input.role === 'primary';
}

function referenceInputAllowed(input) {
  if (!input) return false;
  if (input.role === 'nearby') return true;
  if (input.role !== 'mentioned') return false;
  // `mentioned` is deliberately lower-context. POI/metro are the motivating
  // cases, but entity-only RC/street mentions follow the same safe fallback.
  return ['residential_complex', 'poi', 'metro', 'street'].includes(input.type);
}

export function applyGeoCatalogExactAnchor(listing, country) {
  if (!listing || hasCoordinates(listing)) return false;
  const { countryCode, city } = canonicalContext(listing, country);
  if (!countryCode || !city) return false;

  const inputs = [
    {
      type: 'residential_complex',
      canonical: listing.residenceComplex,
      role: roleFor(listing, 'residential_complex', listing.residenceComplex),
      origin: 'field',
    },
    {
      type: 'street',
      canonical: listing.street,
      role: roleFor(listing, 'street', listing.street),
      origin: 'field',
    },
    ...(Array.isArray(listing.locationEntities) ? listing.locationEntities : [])
      .map((entity) => ({
        type: entityType(entity?.type),
        canonical: entity?.name,
        role: normalizedRole(entity?.role),
        origin: 'entity',
      }))
      .filter((input) => Object.hasOwn(EXACT_TYPE_PRIORITY, input.type)),
    {
      type: 'metro',
      canonical: listing.metro,
      role: roleFor(listing, 'metro', listing.metro),
      origin: 'field',
    },
  ]
    .filter(exactInputAllowed)
    .sort((a, b) => EXACT_TYPE_PRIORITY[a.type] - EXACT_TYPE_PRIORITY[b.type]);

  for (const input of uniqueInputs(inputs)) {
    const entity = resolve(countryCode, city, input.type, input.canonical);
    if (entity && apply(listing, entity, input)) return true;
  }
  return false;
}

export function applyGeoCatalogBroadAnchor(listing, country) {
  if (!listing || hasCoordinates(listing)) return false;
  const { countryCode, city } = canonicalContext(listing, country);
  if (!countryCode || !city) return false;

  const locationEntities = (Array.isArray(listing.locationEntities) ? listing.locationEntities : [])
    .map((entity) => ({
      type: entityType(entity?.type),
      canonical: entity?.name,
      role: normalizedRole(entity?.role),
    }))
    .filter((input) => Object.hasOwn(BROAD_TYPE_PRIORITY, input.type) && input.role !== 'nearby')
    .sort((a, b) => BROAD_TYPE_PRIORITY[a.type] - BROAD_TYPE_PRIORITY[b.type]);

  const inputs = [
    {
      type: 'microdistrict',
      canonical: listing.microdistrict,
      role: roleFor(listing, 'microdistrict', listing.microdistrict),
    },
    ...locationEntities,
    {
      type: 'local_area',
      canonical: listing.area || listing.kvartal,
      role: roleFor(listing, 'local_area', listing.area || listing.kvartal),
    },
    ...(listing.localAreas || []).map((canonical) => ({
      type: 'local_area', canonical, role: roleFor(listing, 'local_area', canonical),
    })),
    ...(listing.suburbs || []).map((canonical) => ({
      type: 'suburb', canonical, role: roleFor(listing, 'suburb', canonical),
    })),
    ...(listing.settlements || []).map((canonical) => ({
      type: 'settlement', canonical, role: roleFor(listing, 'settlement', canonical),
    })),
    {
      type: 'district',
      canonical: listing.district,
      role: roleFor(listing, 'district', listing.district),
    },
  ].filter((input) => input.role !== 'nearby');

  for (const input of uniqueInputs(inputs)) {
    const entity = resolve(countryCode, city, input.type, input.canonical);
    if (entity && apply(listing, entity, input)) return true;
  }
  return false;
}

/**
 * Lower-context point fallback. Historical callers know this as "nearby", but
 * it also accepts an unqualified `mentioned` POI/metro/entity. That distinction
 * is retained in `locationRole`; neither form is allowed back into the exact
 * primary-anchor tier.
 */
export function applyGeoCatalogNearbyAnchor(listing, country) {
  if (!listing || hasCoordinates(listing)) return false;
  const { countryCode, city } = canonicalContext(listing, country);
  if (!countryCode || !city) return false;

  const entityInputs = (Array.isArray(listing.locationEntities) ? listing.locationEntities : [])
    .map((entity) => ({
      type: entityType(entity?.type),
      canonical: entity?.name,
      role: normalizedRole(entity?.role),
      origin: 'entity',
    }));

  const fieldInputs = [
    {
      type: 'residential_complex',
      canonical: listing.residenceComplex,
      role: roleFor(listing, 'residential_complex', listing.residenceComplex),
      origin: 'field',
    },
    {
      type: 'metro',
      canonical: listing.metro,
      role: roleFor(listing, 'metro', listing.metro),
      origin: 'field',
    },
    {
      type: 'street',
      canonical: listing.street,
      role: roleFor(listing, 'street', listing.street),
      origin: 'field',
    },
  ];

  const inputs = [...entityInputs, ...fieldInputs]
    .filter((input) => Object.hasOwn(REFERENCE_TYPE_PRIORITY, input.type))
    .filter(referenceInputAllowed)
    .sort((a, b) => REFERENCE_TYPE_PRIORITY[a.type] - REFERENCE_TYPE_PRIORITY[b.type]);

  if (listing.landmark) {
    inputs.push({ type: 'poi', canonical: listing.landmark, role: 'nearby', origin: 'field' });
  }

  for (const input of uniqueInputs(inputs)) {
    const entity = resolve(countryCode, city, input.type, input.canonical);
    if (entity && apply(listing, entity, input)) return true;
  }
  return false;
}

export function applyGeoCatalogCityFallback(listing, country) {
  if (!listing || hasCoordinates(listing)) return false;
  const { countryCode, city } = canonicalContext(listing, country);
  if (!countryCode || !city) return false;
  const entity = resolve(countryCode, city, 'city', city);
  return Boolean(entity && apply(listing, entity, { type: 'city', canonical: city, role: 'mentioned' }));
}

export const __geoCatalogPriorityTest = {
  exactInputAllowed,
  referenceInputAllowed,
};
