import {
  annotateTransportFallbackFromPlaces,
  geocodeCandidates,
  geocodeListings,
  resolveAccuracyM,
} from './geocode.js';
import {
  cachedNominatimPoint,
  fetchNominatimPoint,
} from './nominatim-client.js';
import {
  cachedStructuredAddressPoint,
  fetchStructuredAddressPoint,
} from './nominatim-structured.js';
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
const EXACT_CANDIDATE_PRIORITY = Object.freeze({
  residentialComplex: 10,
  poi: 20,
  metro: 30,
  street: 40,
});
const PRECISION_RANK = Object.freeze({
  building: 10,
  complex: 20,
  reference: 30,
  station: 40,
  street: 50,
  spatial: 60,
  neighborhood: 70,
  locality: 75,
  broad: 80,
  district: 90,
  city: 100,
});
const EARTH_RADIUS_M = 6_371_000;
const CATALOG_COORDINATE_TOLERANCE_M = 1;
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

function reverseGeneratedAddress(listing) {
  return /^reverse/i.test(String(listing?.addressSource || ''));
}

function precisionRank(value) {
  return PRECISION_RANK[String(value || '')] ?? PRECISION_RANK.broad;
}

function isStrongerPlacement(candidate, current) {
  if (!candidate || !hasCoordinates(candidate)) return false;
  if (current?.locationApproximate === false && precisionRank(current.locationPrecision) <= PRECISION_RANK.building) {
    return false;
  }
  return precisionRank(candidate.locationPrecision) < precisionRank(current?.locationPrecision);
}

function placementProbe(listing) {
  return {
    ...listing,
    lat: null,
    lng: null,
    locationSource: null,
    locationAccuracyM: null,
    locationExtentM: null,
    locationPrecision: null,
    locationApproximate: null,
    locationCanonical: null,
    locationRole: null,
    locationProvider: null,
    locationProviderId: null,
    locationProviderType: null,
    locationGeoEntityId: null,
  };
}

function rememberSourceCoordinate(listing, original) {
  listing.sourceCoordinateRefined = true;
  listing.sourceCoordinateLat ??= Number(original.lat);
  listing.sourceCoordinateLng ??= Number(original.lng);
  listing.sourceCoordinateOriginalSource ??= original.locationSource || 'sourceCoordinates';
  listing.sourceCoordinateOriginalPrecision ??= original.locationPrecision || 'broad';
  const discrepancyM = distanceM(original, listing);
  if (Number.isFinite(discrepancyM)) listing.sourceCoordinateDistanceM = Math.round(discrepancyM);
}

function copyPlacement(target, source, original = null) {
  const fields = [
    'lat', 'lng', 'locationSource', 'locationAccuracyM', 'locationExtentM',
    'locationPrecision', 'locationApproximate', 'locationCanonical', 'locationRole',
    'locationProvider', 'locationProviderId', 'locationProviderType',
    'locationGeoEntityId',
  ];
  for (const field of fields) {
    if (source[field] !== undefined) target[field] = source[field];
  }
  if (original) rememberSourceCoordinate(target, original);
}

function applyCandidate(listing, candidate, coords, source = candidate.source) {
  listing.lat = Number(coords.lat);
  listing.lng = Number(coords.lng);
  listing.locationSource = source;
  listing.locationAccuracyM = resolveAccuracyM(
    finiteAccuracy(coords.locationAccuracyM, candidate.accuracyM),
    coords,
  );
  listing.locationExtentM = finiteAccuracy(coords.extentM, finiteAccuracy(coords.locationExtentM));
  listing.locationPrecision = coords.precision || coords.locationPrecision || candidate.precision || null;
  listing.locationApproximate = candidate.approximate ?? source !== 'address';
  if (listing.locationPrecision === 'building' && source === 'address') {
    listing.locationApproximate = false;
  }
  listing.locationCanonical = coords.locationCanonical || candidate.name || null;
  listing.locationRole = coords.locationRole || candidate.role || 'mentioned';
  listing.locationProvider = coords.provider
    || coords.locationProvider
    || (String(source || '').startsWith('learned') ? 'learned' : 'nominatim');
  listing.locationProviderId = coords.providerId || coords.locationProviderId || null;
  listing.locationProviderType = coords.providerType || coords.locationProviderType || null;
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

function structuredInputFor(listing, country, candidate) {
  const expectation = candidate?.nominatim || {};
  const street = expectation.street || listing?.street;
  const houseNumber = expectation.houseNumber || listing?.houseNumber;
  if (candidate?.source !== 'address' || !street || !houseNumber) return null;
  return {
    street,
    houseNumber,
    building: expectation.building || listing?.building || null,
    city: expectation.city || listing?.city || null,
    countryCode: country?.code || null,
  };
}

async function tryExactCandidate(listing, country, candidate, budget) {
  if (candidate?.role === 'nearby') return { placed: false, usedBudget: false, deferred: false };
  const descriptor = learnedGeoDescriptor(listing, country, candidate);
  const learned = await learnedLookup(descriptor);
  if (learned) {
    applyCandidate(listing, candidate, learned, learned.source);
    return { placed: true, usedBudget: false, deferred: false };
  }

  let usedBudget = false;
  const structuredInput = structuredInputFor(listing, country, candidate);
  if (structuredInput) {
    let coords = await cachedStructuredAddressPoint(structuredInput);
    if (coords === undefined) {
      if (budget.value <= 0) {
        return { placed: false, usedBudget, deferred: true };
      }
      budget.value -= 1;
      usedBudget = true;
      coords = await fetchStructuredAddressPoint(structuredInput);
    }
    if (coords) {
      applyCandidate(listing, candidate, coords);
      await remember(descriptor, coords);
      return { placed: true, usedBudget, deferred: false };
    }
  }

  const expectation = candidate.nominatim || {};
  let coords = await cachedNominatimPoint(candidate.q, country?.code, expectation);
  if (coords === undefined) {
    if (budget.value <= 0) {
      return { placed: false, usedBudget, deferred: true };
    }
    budget.value -= 1;
    usedBudget = true;
    coords = await fetchNominatimPoint(candidate.q, country?.code, expectation);
  }
  if (!coords) return { placed: false, usedBudget, deferred: false };

  applyCandidate(listing, candidate, coords);
  await remember(descriptor, coords);
  return { placed: true, usedBudget, deferred: false };
}

async function refineSourceCoordinateFromExactAddress(listing, country, candidates, budget) {
  if (!listing?.street || !listing?.houseNumber || reverseGeneratedAddress(listing)) {
    return { refined: false, deferred: false };
  }

  const original = { ...listing, lat: Number(listing.lat), lng: Number(listing.lng) };
  const exactCandidates = candidates.filter((item) => item.source === 'address');
  let deferred = false;
  for (const candidate of exactCandidates) {
    const probe = placementProbe(listing);
    const result = await tryExactCandidate(probe, country, candidate, budget);
    deferred ||= result.deferred;
    if (!result.placed) continue;
    if (!isStrongerPlacement(probe, listing)) continue;

    copyPlacement(listing, probe, original);
    return { refined: true, deferred };
  }
  return { refined: false, deferred };
}

function refineSourceCoordinateFromCatalog(listing, country) {
  const original = { ...listing, lat: Number(listing.lat), lng: Number(listing.lng) };
  const probe = placementProbe(listing);
  if (!applyGeoCatalogExactAnchor(probe, country)) return false;
  if (!isStrongerPlacement(probe, listing)) return false;
  copyPlacement(listing, probe, original);
  return true;
}

async function refineSourceCoordinateFromExactEntities(listing, country, candidates, budget) {
  const original = { ...listing, lat: Number(listing.lat), lng: Number(listing.lng) };
  const exactCandidates = candidates
    .filter((item) =>
      (ENTITY_EXACT_SOURCES.has(item.source) || STREET_SOURCES.has(item.source))
        && item.role !== 'nearby',
    )
    .sort((a, b) =>
      (EXACT_CANDIDATE_PRIORITY[a.source] ?? 999) - (EXACT_CANDIDATE_PRIORITY[b.source] ?? 999),
    );
  let deferred = false;

  for (const candidate of exactCandidates) {
    const probe = placementProbe(listing);
    const result = await tryExactCandidate(probe, country, candidate, budget);
    deferred ||= result.deferred;
    if (!result.placed) continue;
    if (!isStrongerPlacement(probe, listing)) continue;
    copyPlacement(listing, probe, original);
    return { refined: true, deferred };
  }
  return { refined: false, deferred };
}

function sourceCoordinateIsStrongerThanComplex(listing) {
  if (listing?.locationApproximate === false) return true;
  if (String(listing?.locationPrecision || '').toLowerCase() === 'building') return true;
  return listing?.locationSource === 'address';
}

export function refineSourceCoordinateFromGeoCatalogResidentialComplex(listing, country) {
  if (!hasCoordinates(listing) || sourceCoordinateIsStrongerThanComplex(listing)) return false;

  const original = { lat: Number(listing.lat), lng: Number(listing.lng) };
  const probe = {
    ...listing,
    lat: null,
    lng: null,
    locationSource: null,
    locationAccuracyM: null,
    locationExtentM: null,
    locationPrecision: null,
    locationApproximate: null,
    locationCanonical: null,
    locationRole: null,
    locationProvider: null,
    locationProviderId: null,
    locationProviderType: null,
    locationGeoEntityId: null,
  };

  if (!applyGeoCatalogExactAnchor(probe, country)) return false;
  if (probe.locationSource !== 'residentialComplex' || probe.locationRole === 'nearby') return false;

  const discrepancyM = distanceM(original, probe);
  if (!Number.isFinite(discrepancyM)) return false;

  const alreadyCurrentCatalogAnchor = listing.locationSource === 'residentialComplex'
    && listing.locationProvider === 'geoCatalog'
    && listing.locationGeoEntityId
    && listing.locationGeoEntityId === probe.locationGeoEntityId
    && discrepancyM <= CATALOG_COORDINATE_TOLERANCE_M;
  if (alreadyCurrentCatalogAnchor) return false;

  Object.assign(listing, probe);
  listing.sourceCoordinateRefined = true;
  listing.sourceCoordinateDistanceM = Math.round(discrepancyM);
  return true;
}

export async function geocodeListingsPersistent(listings, country) {
  if (!Array.isArray(listings) || !country) return listings;

  applyStructuredAddressFieldsBatch(listings);
  const sourceAddressProvided = new WeakSet(
    listings.filter((listing) =>
      typeof listing?.address === 'string'
        && listing.address.trim()
        && listing.addressSource === 'source',
    ),
  );
  const packageResolved = new WeakSet();
  const exactDeferred = new WeakSet();
  const budget = { value: EXACT_LOOKUP_BUDGET };

  for (const listing of listings) {
    if (!listing) continue;

    const candidates = geocodeCandidates(listing, country);
    if (hasCoordinates(listing)) {
      const addressRefinement = await refineSourceCoordinateFromExactAddress(listing, country, candidates, budget);
      if (addressRefinement.refined || addressRefinement.deferred) continue;

      if (refineSourceCoordinateFromCatalog(listing, country)) {
        packageResolved.add(listing);
        continue;
      }

      await refineSourceCoordinateFromExactEntities(listing, country, candidates, budget);
      continue;
    }

    let placed = false;
    let deferred = false;

    for (const candidate of candidates.filter((item) =>
      ADDRESS_SOURCES.has(item.source)
        && (sourceAddressProvided.has(listing) || item.precision === 'building'),
    )) {
      const result = await tryExactCandidate(listing, country, candidate, budget);
      deferred ||= result.deferred;
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

    const entityCandidates = candidates
      .filter((item) => ENTITY_EXACT_SOURCES.has(item.source) && item.role !== 'nearby')
      .sort((a, b) =>
        (EXACT_CANDIDATE_PRIORITY[a.source] ?? 999) - (EXACT_CANDIDATE_PRIORITY[b.source] ?? 999),
      );
    for (const candidate of entityCandidates) {
      const result = await tryExactCandidate(listing, country, candidate, budget);
      deferred ||= result.deferred;
      if (result.placed) {
        placed = true;
        break;
      }
    }
    if (placed) continue;

    for (const candidate of candidates.filter((item) =>
      STREET_SOURCES.has(item.source)
        || (ADDRESS_SOURCES.has(item.source) && !sourceAddressProvided.has(listing) && item.precision !== 'building'),
    )) {
      const result = await tryExactCandidate(listing, country, candidate, budget);
      deferred ||= result.deferred;
      if (result.placed) {
        placed = true;
        break;
      }
    }
    if (placed) continue;

    // Never fall through to a weaker broad/reference point merely because the
    // exact-lookup budget ended before a stronger candidate could be proved or
    // rejected. Leave the listing unresolved for this refresh; a later refresh
    // can continue once cache/budget is available.
    if (deferred) {
      exactDeferred.add(listing);
      continue;
    }

    if (applyGeoCatalogBroadAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }

    const constrainedReferences = candidates.filter((item) =>
      item.role === 'nearby' && item.distanceM != null,
    );
    if (constrainedReferences.length < 2 && applyGeoCatalogNearbyAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }
  }

  await geocodeListings(listings.filter((listing) => !exactDeferred.has(listing)), country);
  await annotateNearbyTransport(listings, country);
  await annotateTransportFallbackFromPlaces(listings, country);

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

export const __geocodePersistentTest = {
  precisionRank,
  isStrongerPlacement,
  structuredInputFor,
  placementProbe,
};
