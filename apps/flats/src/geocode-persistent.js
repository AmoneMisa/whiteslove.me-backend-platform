import { cacheSet } from './cache.js';
import { geocodeCandidates, geocodeListings, geocodeQuery } from './geocode.js';
import {
  applyGeoCatalogBroadAnchor,
  applyGeoCatalogCityFallback,
  applyGeoCatalogExactAnchor,
} from './geo-catalog.js';
import {
  findLearnedGeo,
  learnedGeoDescriptor,
  rememberLearnedGeo,
} from './learned-geo.js';
import { applyStructuredAddressFieldsBatch } from './structured-address.js';
import { annotateNearbyTransport } from './transport-nearby.js';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXACT_SOURCES = new Set(['address', 'street']);
const ENTITY_EXACT_SOURCES = new Set(['residentialComplex', 'metro']);
const LEARNABLE_SOURCES = new Set([...EXACT_SOURCES, ...ENTITY_EXACT_SOURCES]);
const EARTH_RADIUS_M = 6_371_000;
const EXACT_LOOKUP_BUDGET = Math.max(
  0,
  Number(process.env.PERSISTENT_EXACT_GEOCODE_BUDGET ?? 30) || 0,
);
const SOURCE_COORD_EXACT_MAX_DISTANCE_M = Math.max(
  0,
  Number(process.env.SOURCE_COORD_EXACT_MAX_DISTANCE_M ?? 150) || 0,
);

function hasCoordinates(listing) {
  return listing?.lat != null
    && listing?.lng != null
    && Number.isFinite(Number(listing.lat))
    && Number.isFinite(Number(listing.lng));
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

function cacheKey(query) {
  return `geo:v2:${String(query).toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

function applyCandidate(listing, candidate, coords, source = candidate.source) {
  listing.lat = Number(coords.lat);
  listing.lng = Number(coords.lng);
  listing.locationSource = source;
  listing.locationAccuracyM = Number(coords.accuracyM) || candidate.accuracyM;
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
    return await rememberLearnedGeo(descriptor, coords, { name: 'nominatim' });
  } catch (error) {
    console.warn('[geo:learned] persist degraded:', error?.message || error);
    return false;
  }
}

async function warmPackageFallback(listing, country, candidates, applyPackageAnchor) {
  const clone = { ...listing, lat: null, lng: null };
  if (!applyPackageAnchor(clone, country) || !hasCoordinates(clone)) return false;

  const candidate = candidates.find((item) => item.source === clone.locationSource);
  if (!candidate?.q) return false;

  await cacheSet(
    cacheKey(candidate.q),
    { coords: { lat: Number(clone.lat), lng: Number(clone.lng) } },
    CACHE_TTL_MS,
  );
  return true;
}

async function tryExactCandidate(listing, country, candidate, budget) {
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
  const coords = await geocodeQuery(candidate.q, country?.code);
  if (!coords) return { placed: false, usedBudget: true, deferred: false };

  applyCandidate(listing, candidate, coords);
  await remember(descriptor, coords);
  return { placed: true, usedBudget: true, deferred: false };
}

async function refineSourceCoordinateFromExactAddress(listing, country, candidates, budget) {
  // A street centroid is not sufficient evidence to move a marketplace pin. Only
  // refine existing coordinates when parsing-lexicon resolved a concrete house.
  if (!listing?.street || !listing?.houseNumber) return false;

  const original = { lat: Number(listing.lat), lng: Number(listing.lng) };
  const exactCandidates = candidates.filter((item) => item.source === 'address');
  for (const candidate of exactCandidates) {
    const probe = { ...listing, lat: null, lng: null, locationSource: null, locationAccuracyM: null };
    const result = await tryExactCandidate(probe, country, candidate, budget);
    if (!result.placed) continue;

    const discrepancyM = distanceM(original, probe);
    if (!Number.isFinite(discrepancyM)) return false;

    if (discrepancyM > SOURCE_COORD_EXACT_MAX_DISTANCE_M) {
      applyCandidate(listing, candidate, probe, probe.locationSource || candidate.source);
      listing.sourceCoordinateRefined = true;
      listing.sourceCoordinateDistanceM = Math.round(discrepancyM);
      return true;
    }

    // The source point agrees with the exact address. Preserve it, but record a
    // realistic validated accuracy instead of blindly labelling every source pin 25 m.
    listing.locationSource ??= 'coordinates-validated';
    listing.locationAccuracyM ??= Math.max(25, Math.ceil(discrepancyM));
    return false;
  }
  return false;
}

/**
 * Persistent geocoding orchestration.
 *
 * The existing geocode.js remains the final Nominatim/spatial/reverse-geo
 * implementation. This layer adds deterministic package/database lookups in
 * front of it without weakening exact-address priority.
 */
export async function geocodeListingsPersistent(listings, country) {
  if (!Array.isArray(listings) || !country) return listings;

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

    // 1. House/street coordinates learned earlier, then an exact external lookup.
    for (const candidate of candidates.filter((item) => EXACT_SOURCES.has(item.source))) {
      const result = await tryExactCandidate(listing, country, candidate, budget);
      exactDeferred ||= result.deferred;
      if (result.placed) {
        placed = true;
        break;
      }
    }
    if (placed) continue;

    // 2. Stable canonical ЖК/metro anchors belong to geo-catalog and outrank HTTP.
    if (applyGeoCatalogExactAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }

    // 3. If geo-catalog has no ЖК/metro anchor, use learned DB then Nominatim.
    for (const candidate of candidates.filter((item) => ENTITY_EXACT_SOURCES.has(item.source))) {
      const result = await tryExactCandidate(listing, country, candidate, budget);
      exactDeferred ||= result.deferred;
      if (result.placed) {
        placed = true;
        break;
      }
    }
    if (placed) continue;

    // 4. Coarser package anchors are used only after every exact candidate has
    // actually been attempted. If the wrapper budget is exhausted, warm the
    // existing pipeline cache instead so it can attempt exact HTTP first.
    if (!exactDeferred && applyGeoCatalogBroadAnchor(listing, country)) {
      packageResolved.add(listing);
      continue;
    }
    if (exactDeferred) {
      await warmPackageFallback(listing, country, candidates, applyGeoCatalogBroadAnchor);
    }

    // City center is always a package fallback; never spend a Nominatim request
    // on a city already present in geo-catalog.
    await warmPackageFallback(listing, country, candidates, applyGeoCatalogCityFallback);
  }

  // Existing pipeline handles unresolved exact/broad HTTP, spatial POI solving,
  // reverse geocoding and POI annotations. Rows already placed above are skipped
  // by its coordinate guard but still receive the final annotations.
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
      .find((item) => item.source === listing.locationSource);
    const descriptor = learnedGeoDescriptor(listing, country, candidate);
    await remember(descriptor, { lat: Number(listing.lat), lng: Number(listing.lng) });
  }

  return listings;
}
