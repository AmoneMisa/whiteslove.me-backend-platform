// Public geocoding facade.
//
// Coordinate evidence order (strongest -> weakest) is defined by
// GEO_ACCURACY_AUDIT.md and must not be changed independently here:
//   exact street+house -> canonical residential complex -> primary POI
//   -> primary metro -> bare street -> spatial inference -> local geography
//   -> nearby/reference anchors -> district.
//
// The historical implementation remains in geocode-base.js for the mature
// spatial/reverse/nearby stages. This facade performs the point-like Nominatim
// stage in the required order before delegating, so direct callers cannot
// accidentally restore the old street-before-POI/metro behaviour. The normal
// ingestion path still goes through geocode-persistent.js, which additionally
// prefers canonical geo-catalog anchors and can refine broad source markers.

export * from './geocode-base.js';

import {
  geocodeCandidates,
  geocodeListings as geocodeListingsBase,
  resolveAccuracyM,
} from './geocode-base.js';
import {
  cachedNominatimPoint,
  fetchNominatimPoint,
} from './nominatim-client.js';
import {
  cachedStructuredAddressPoint,
  fetchStructuredAddressPoint,
} from './nominatim-structured.js';

const MAX_LOOKUPS_PER_RUN = Number(process.env.GEOCODE_BUDGET) || 60;
const MAX_LOOKUPS_PER_LISTING = Math.max(1, Number(process.env.GEOCODE_LISTING_BUDGET) || 3);
const EXACT_PRIORITY = Object.freeze({
  address: 10,
  residentialComplex: 20,
  poi: 30,
  metro: 40,
  street: 50,
});

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

function structuredInput(listing, country, candidate) {
  if (candidate?.source !== 'address') return null;
  const expectation = candidate.nominatim || {};
  const street = expectation.street || listing?.street;
  const houseNumber = expectation.houseNumber || listing?.houseNumber;
  if (!street || !houseNumber) return null;
  return {
    street,
    houseNumber,
    building: expectation.building || listing?.building || null,
    city: expectation.city || listing?.city || null,
    countryCode: country?.code || null,
  };
}

function applyCandidate(listing, candidate, coords) {
  listing.lat = Number(coords.lat);
  listing.lng = Number(coords.lng);
  listing.locationSource = candidate.source;
  listing.locationAccuracyM = resolveAccuracyM(candidate.accuracyM, coords);
  listing.locationExtentM = finiteAccuracy(coords.extentM);
  listing.locationPrecision = coords.precision || candidate.precision || null;
  listing.locationApproximate = candidate.approximate ?? candidate.source !== 'address';
  if (candidate.source === 'address' && listing.locationPrecision === 'building') {
    listing.locationApproximate = false;
  }
  listing.locationCanonical = candidate.name || null;
  listing.locationRole = candidate.role || 'mentioned';
  listing.locationProvider = coords.provider || 'nominatim';
  listing.locationProviderId = coords.providerId || null;
  listing.locationProviderType = coords.providerType || null;
}

/**
 * Exact point-like evidence must carry enough relationship context to justify
 * placing the apartment on the anchor itself. A POI/metro merely mentioned in
 * text is a reference, not the apartment location, so it is deliberately kept
 * out of the exact stage and may only participate in the later reference tier.
 */
export function exactCandidateAllowed(candidate) {
  if (!candidate || candidate.role === 'nearby') return false;
  if (!Object.hasOwn(EXACT_PRIORITY, candidate.source)) return false;
  if (candidate.source === 'poi' || candidate.source === 'metro') {
    return candidate.role === 'primary';
  }
  return true;
}

function exactCandidates(listing, country) {
  return geocodeCandidates(listing, country)
    .filter(exactCandidateAllowed)
    .sort((a, b) => EXACT_PRIORITY[a.source] - EXACT_PRIORITY[b.source]);
}

async function lookupExact(listing, country, candidate, budgets) {
  if (!exactCandidateAllowed(candidate)) return {coords: null, deferred: false};

  const structured = structuredInput(listing, country, candidate);
  if (structured) {
    let coords = await cachedStructuredAddressPoint(structured);
    if (coords === undefined) {
      if (budgets.run <= 0 || budgets.listing <= 0) return {coords: null, deferred: true};
      budgets.run -= 1;
      budgets.listing -= 1;
      coords = await fetchStructuredAddressPoint(structured);
    }
    if (coords) return {coords, deferred: false};
  }

  const expectation = candidate.nominatim || {};
  let coords = await cachedNominatimPoint(candidate.q, country?.code, expectation);
  if (coords === undefined) {
    if (budgets.run <= 0 || budgets.listing <= 0) return {coords: null, deferred: true};
    budgets.run -= 1;
    budgets.listing -= 1;
    coords = await fetchNominatimPoint(candidate.q, country?.code, expectation);
  }
  return {coords: coords || null, deferred: false};
}

/**
 * Correctly orders point-like evidence for callers that use the lightweight
 * geocoder directly. A budget exhaustion is not interpreted as proof that the
 * stronger candidate does not exist: that listing is deferred rather than
 * downgraded to a weaker broad point in the same pass.
 */
export async function geocodeListings(listings, country) {
  if (!Array.isArray(listings) || !country) return listings;

  const budgets = {run: MAX_LOOKUPS_PER_RUN, listing: MAX_LOOKUPS_PER_LISTING};
  const delegate = [];

  for (const listing of listings) {
    if (!listing) continue;
    budgets.listing = MAX_LOOKUPS_PER_LISTING;

    if (hasCoordinates(listing)) {
      delegate.push(listing);
      continue;
    }

    let placed = false;
    let deferred = false;
    for (const candidate of exactCandidates(listing, country)) {
      const result = await lookupExact(listing, country, candidate, budgets);
      if (result.deferred) {
        deferred = true;
        break;
      }
      if (!result.coords) continue;
      applyCandidate(listing, candidate, result.coords);
      placed = true;
      break;
    }

    // Placed rows are delegated so the mature reverse/nearby annotation stages
    // still run. Proven exact misses are cached, so the base exact loop becomes
    // a no-network no-op before it reaches spatial/broad fallbacks.
    // When the exact stage consumed the per-listing budget, do not hand the
    // row to the historical fallback stage: it would start a second budget
    // and issue extra uncached Nominatim requests for weaker candidates.
    if (placed || (!deferred && budgets.run > 0 && budgets.listing > 0)) {
      delegate.push(listing);
    }
  }

  if (delegate.length) await geocodeListingsBase(delegate, country);
  return listings;
}

export const __geocodeFacadeTest = {
  exactCandidates,
  structuredInput,
  exactPriority: EXACT_PRIORITY,
  exactCandidateAllowed,
};
