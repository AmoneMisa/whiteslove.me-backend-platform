import { refineSourceCoordinateFromGeoCatalogResidentialComplex } from './geocode-persistent.js';

const GEO_PATCH_KEYS = Object.freeze([
  'lat',
  'lng',
  'locationSource',
  'locationAccuracyM',
  'locationExtentM',
  'locationPrecision',
  'locationApproximate',
  'locationCanonical',
  'locationRole',
  'locationProvider',
  'locationProviderId',
  'locationProviderType',
  'locationGeoEntityId',
  'sourceCoordinateRefined',
  'sourceCoordinateDistanceM',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function hydrateResidentialCoordinateBackfillListing(row) {
  const data = object(row?.data);
  const lat = finite(data.lat ?? row?.lat);
  const lng = finite(data.lng ?? row?.lng);
  const country = String(data.country ?? row?.country ?? '').trim().toUpperCase();

  return {
    ...data,
    id: data.id ?? row?.id ?? String(row?.source_id ?? row?.db_id ?? ''),
    source: data.source ?? row?.source ?? null,
    country,
    city: data.city ?? row?.city ?? null,
    residenceComplex: data.residenceComplex ?? row?.residenceComplex ?? row?.residence_complex ?? null,
    lat,
    lng,
  };
}

export function buildResidentialCoordinateBackfillPatch(row) {
  const listing = hydrateResidentialCoordinateBackfillListing(row);
  if (!listing.country || !listing.city || !listing.residenceComplex) return null;
  if (!Number.isFinite(listing.lat) || !Number.isFinite(listing.lng)) return null;

  const changed = refineSourceCoordinateFromGeoCatalogResidentialComplex(
    listing,
    { code: listing.country },
  );
  if (!changed) return null;

  const patch = {};
  for (const key of GEO_PATCH_KEYS) {
    if (Object.hasOwn(listing, key)) patch[key] = listing[key];
  }
  return Object.freeze(patch);
}
