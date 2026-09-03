import { geocodeCandidates, geocodeListings, geocodeQuery } from './geocode.js';
import {
  applyGeoCatalogBroadAnchor,
  applyGeoCatalogExactAnchor,
  applyGeoCatalogNearbyAnchor,
} from './geo-catalog.js';
import {
  findLearnedGeo,
  learnedGeoDescriptor,
  rememberLearnedGeo,
} from './learned/learned-geo.js';
import { applyStructuredAddressFieldsBatch } from './structured-address.js';
import { annotateNearbyTransport } from './transport-nearby.js';

const ADDRESS_SOURCES = new Set(['address']);
const STREET_SOURCES = new Set(['street']);
const ENTITY_EXACT_SOURCES = new Set(['residentialComplex', 'poi', 'metro']);
const LEARNABLE_SOURCES = new Set([...ADDRESS_SOURCES, ...STREET_SOURCES, ...ENTITY_EXACT_SOURCES]);
const EARTH_RADIUS_M = 6_371_000;
const EXACT_LOOKUP_BUDGET = Math.max(
  0,
  Number(process.env.PERSISTENT_EXACT_GEOCODE_BUDGET ?? 30) || 0,
);

function hasCoordinates(listing) {
  return listing?.lat != null
    && listing?.lng != null
    && Number.isFinite(Number(listing.lat))
    && Number.isFinite(Number(listing.lng));
}

function finiteAccuracy(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function distanceM(a, b) {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng) - toRad(a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function applyCandidate(listing, candidate, coords, source = candidate.source) {
  listing.lat = Number(coords.lat);
  listing.lng = Number(coords.lng);
  listing.locationSource = source;
  listing.locationAccuracyM = finiteAccuracy(coords.accuracyM, finiteAccuracy(candidate.accuracyM));
  listing.locationPrecision = coords.precision || candidate.precision || null;
  listing.locationApproximate = candidate.approximate ?? source !== 'address';
  if (listing.locationPrecision === 'building' && source === 'address') {
    listing.locationApproximate = false;
  }
  listing.locationCanonical = candidate.name || null;
  listing.locationRole = candidate.role || 'mentioned';
  listing.locationProvider = coords.provider
    || (String(source || '').startsWith('learned') ? 'learned' : 'nominatim');
  listing.locationProviderId = coords.providerId || null;
  listing.locationProviderType = coords.providerType || null;
}

async function learnedLookup(descriptor) {
  if (!descriptor) return null;
  try {
    return await findLearnedGeo(descriptor);
  } catch (error) {
    console.warn('[geo:learned] lookup degraded:', error?.message || error);
    return null;
  }
}

async function remember(descriptor, coords) {
  if (!descriptor) return false;
  try {
    return await rememberLearnedGeo(descriptor, coords);
  } catch (error) {
    console.warn('[geo:learned] persist degraded:', error?.message || error);
    return false;
  }
}

async function tryExactCandidate(listing, country, candidate, budget) {
  if (candidate?.role === 'nearby') return { placed: false, usedBudget: false, deferred: false };
  const descriptor = learnedGeoDescriptor(listing, country, candidate);
  const learned = await learnedLookup(descriptor);
  if (learned) {
    applyCandidate(listing, candidate, learned, learned.source);
    return { placed: true, usedBudget: false, deferred: false };
  }

  if (budget.value <= 0) {
    return { placed: false, usedBudget: false, deferred: true };
  }

  budget.value -= 1;
  const coords = await geocodeQuery(candidate.q, country?.code, candidate.nominatim || {});
  if (!coords) return { placed: false, usedBudget: true, deferred: false };

  applyCandidate(listing, candidate, coords);
  await remember(descriptor, coords);
  return { placed: true, usedBudget: true, deferred: false };
}

async function refineSourceCoordinateFromExactAddress(listing, country, candidates, budget) {
  if (!listing?.street || !listing?.houseNumber) return false;

  const original = { lat: Number(listing.lat), lng: Number(listing.lng) };
  const exactCandidates = candidates.filter((item) => item.source === 'address');
  for (const candidate of exactCandidates) {
    const probe = { ...listing, lat: null, lng: null, locationSource: null, locationAccuracyM: null };
    const result = await tryExactCandidate(probe, country, candidate, budget);
    if (!result.placed) continue;

    const discrepancyM = distanceM(original, probe);
    if (!Number.isFinite(discrepancyM)) return false;

    applyCandidate(listing, candidate, probe, probe.locationSource || candidate.source);
    listing.sourceCoordinateRefined = true;
    listing.sourceCoordinateDistanceM = Math.round(discrepancyM);
    return true;
  }
  return false;
}

export async function geocodeListingsPersistent(listings, country) {
  if (!Array.isArray(listings) || !country) return listings;

  const sourceAddressProvided = new WeakSet(
    listings.filter((listing) => typeof listing?.address === 'string' && listing.address.trim()),
  );

  applyStructuredAddressFieldsBatch(listings);
  const packageResolved = new WeakSet();
  const budget = { value: EXACT_LOOKUP_BUDGET };

  for (const listing of listings) {
    if (!listing) continue;

    const candidates = geocodeCandidates(listing, country);
    if (hasCoordinates(listing)) {
      await refineSourceCoordinateFromExactAddress(listing, country, candidates, budget);
      continue;
    }

    let placed = false;
    let exactDeferred = false;

    for (const candidate of candidates.filter((item) =>
      ADDRESS_SOURCES.has(item.source)
        && (sourceAddressProvided.has(listing) || item.precision === 'building'),
    )) {
      const result = await tryExactCandidate(listing, country, candidate, budget);
      exactDeferred ||= result.deferred;
      if (result.placed) {
        placed = true;
        break;
      }
    }
    if (placed) continue;

    if (applyGeoCatalogExactAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }

    for (const candidate of candidates.filter((item) =>
      STREET_SOURCES.has(item.source)
        || (ADDRESS_SOURCES.has(item.source) && !sourceAddressProvided.has(listing) && item.precision !== 'building'),
    )) {
      const result = await tryExactCandidate(listing, country, candidate, budget);
      exactDeferred ||= result.deferred;
      if (result.placed) {
        placed = true;
        break;
      }
    }
    if (placed) continue;

    for (const candidate of candidates.filter((item) =>
      ENTITY_EXACT_SOURCES.has(item.source) && item.role !== 'nearby',
    )) {
      const result = await tryExactCandidate(listing, country, candidate, budget);
      exactDeferred ||= result.deferred;
      if (result.placed) {
        placed = true;
        break;
      }
    }
    if (placed) continue;

    if (!exactDeferred && applyGeoCatalogBroadAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }

    const constrainedReferences = candidates.filter((item) =>
      item.role === 'nearby' && item.distanceM != null,
    );
    if (!exactDeferred && constrainedReferences.length < 2 && applyGeoCatalogNearbyAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }
  }

  await geocodeListings(listings, country);
  await annotateNearbyTransport(listings, country);

  for (const listing of listings) {
    if (!listing || packageResolved.has(listing) || !hasCoordinates(listing)) continue;
    if (!LEARNABLE_SOURCES.has(listing.locationSource)) continue;

    const candidate = geocodeCandidates(listing, country)
      .find((item) => item.source === listing.locationSource && item.role !== 'nearby');
    const descriptor = learnedGeoDescriptor(listing, country, candidate);
    await remember(descriptor, {
      lat: Number(listing.lat),
      lng: Number(listing.lng),
      accuracyM: listing.locationAccuracyM,
      precision: listing.locationPrecision,
      provider: listing.locationProvider,
      providerId: listing.locationProviderId,
      providerType: listing.locationProviderType,
    });
  }

  return listings;
}
