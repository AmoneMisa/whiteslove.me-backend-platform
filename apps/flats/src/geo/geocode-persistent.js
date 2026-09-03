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
const ENTITY_EXACT_SOURCES = new Set(['residentialComplex', 'metro']);
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
  // A generic marketplace pin has no documented precision in our normalized
  // source model. Once street + house resolve to a strictly validated building,
  // that exact address is stronger evidence and should define the map point.
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

/**
 * Persistent geocoding orchestration.
 *
 * Exact source addresses remain strongest. Canonical package anchors are tried
 * before external guesses; contextual "near" entities are deliberately deferred
 * until primary address/ЖК/street/local-area evidence has failed.
 */
export async function geocodeListingsPersistent(listings, country) {
  if (!Array.isArray(listings) || !country) return listings;

  // Preserve whether the upstream source itself supplied an address. The
  // structured parser may later synthesize `address` from a bare detected street;
  // that street-level value must not outrank a known residential-complex point.
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

    // 1. A source-supplied address, or a parsed address with a concrete house,
    // always wins. A parser-synthesized street-only `address` is deferred below.
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

    // 2. Stable canonical ЖК/metro anchors are safer than free-text HTTP guesses.
    if (applyGeoCatalogExactAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }

    // 3. A directly stated street is useful, but remains approximate without a
    // house. This also catches parser-synthesized street-only `address` values.
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

    // 4. Missing canonical ЖК/metro anchors may fall back to learned DB/Nominatim,
    // but never when the lexicon marked the mention as a nearby reference.
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

    // 5. Canonical microdistrict/mahalla/local-area anchors beat unbounded
    // landmarks. If a stronger HTTP lookup was only deferred by this wrapper's
    // budget, leave the row unresolved so geocode.js can still try that exact
    // candidate with its own budget instead of pre-empting it with a broad point.
    if (!exactDeferred && applyGeoCatalogBroadAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }

    // 6. If no primary geometry exists, a known nearby ЖК/POI/metro is still a
    // useful approximate anchor. Do not preempt a two-distance spatial solution.
    const constrainedReferences = candidates.filter((item) =>
      item.role === 'nearby' && item.distanceM != null,
    );
    if (!exactDeferred && constrainedReferences.length < 2 && applyGeoCatalogNearbyAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }
  }

  // Existing pipeline handles unresolved HTTP, multi-anchor spatial solving,
  // reverse geocoding and POI annotations. Package-resolved rows are skipped by
  // its coordinate guard but still receive final annotations.
  await geocodeListings(listings, country);

  // Canonical transport topology belongs to geo-catalog. This enrichment is
  // intentionally after reverse/POI annotation so every precise coordinate —
  // whether sourced, addressed, street-resolved or POI-solved — gets the same
  // complete nearby metro/public-transport arrays.
  await annotateNearbyTransport(listings, country);

  // Exact results produced by the legacy pipeline are promoted to PostgreSQL.
  // Package-resolved rows are deliberately excluded so the staging table never
  // duplicates coordinates that geo-catalog already owns.
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
