import {enrichListingDetails} from './listing-enrichment.js';
import {geocodeListings} from './geocode.js';
import {getRates} from './fx.js';
import {attachMarketComparisons} from './market-comparison.js';
import {annotateNearbyTransport} from './transport-nearby.js';

const TRANSIENT_DERIVED_FIELDS = [
  'nearbyMetro',
  'nearbyTransport',
  'metroNearby',
  'metroSource',
  'metroDistanceM',
  'transportSource',
  'marketComparison',
];

// These values are deterministic derivatives of the current listing payload.
// If the live adapter did not provide them, do not inherit an old parsed value:
// enrichListingDetails must derive it again from the fresh title/description.
const RECOMPUTABLE_PARSED_FIELDS = [
  'addressStreet',
  'addressHouseNumber',
  'addressBuilding',
  'commissionAmount',
  'cadastral',
  'audienceAlternatives',
  'studentTarget',
  'landlordPresent',
  'priceScope',
  'perPersonPrice',
  'transitRoutes',
  'utilitiesAmount',
  'potentiallyUnsafe',
];

function hasFiniteCoordinate(value) {
  return value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value));
}

function hasFiniteCoordinates(listing) {
  return hasFiniteCoordinate(listing?.lat) && hasFiniteCoordinate(listing?.lng);
}

function copyGeoProvenance(target, source) {
  for (const key of ['locationSource', 'locationAccuracyM', 'locationAnchorCount']) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) target[key] = source[key];
    else delete target[key];
  }
}

/**
 * Merge a live source refresh with the richer normalized snapshot already kept
 * in PostgreSQL. Fresh source fields win, while fields the source adapter does
 * not know how to produce (vision/provenance/etc.) survive the refresh.
 *
 * Recomputable parsed fields, transport and market data are deliberately not
 * inherited from the old snapshot: they depend on current source text,
 * coordinates or price and therefore must be rebuilt rather than copied stale.
 */
export function mergeStoredFreshListing(stored, fresh) {
  const previous = stored && typeof stored === 'object' ? stored : {};
  const current = fresh && typeof fresh === 'object' ? fresh : {};
  const merged = {...previous, ...current};

  for (const key of RECOMPUTABLE_PARSED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) delete merged[key];
  }

  const freshHasCoordinates = hasFiniteCoordinates(current);
  const storedHasCoordinates = hasFiniteCoordinates(previous);

  if (freshHasCoordinates) {
    merged.lat = Number(current.lat);
    merged.lng = Number(current.lng);
    // A fresh source point invalidates provenance belonging to the old point.
    // If a source adapter eventually starts providing its own provenance, keep it.
    copyGeoProvenance(merged, current);
  } else if (storedHasCoordinates && current.sourceCoordinateRejected !== true) {
    // A source that simply omitted coordinates must not erase a previously
    // derived/validated point. geocodeListings can still refine its metadata.
    merged.lat = Number(previous.lat);
    merged.lng = Number(previous.lng);
    copyGeoProvenance(merged, previous);
  }

  for (const key of TRANSIENT_DERIVED_FIELDS) delete merged[key];
  return merged;
}

async function attachMarketComparison(listing) {
  try {
    const {rates} = await getRates();
    const [withMarket] = await attachMarketComparisons([listing], rates);
    return withMarket || listing;
  } catch (error) {
    console.warn('[listing-public] market comparison failed:', error?.message ?? error);
    return listing;
  }
}

async function attachTransport(listing, country) {
  if (!listing || !country) return listing;
  try {
    await annotateNearbyTransport([listing], country);
  } catch (error) {
    console.warn('[listing-public] transport enrichment failed:', error?.message ?? error);
  }
  return listing;
}

/**
 * Final response pipeline shared by every single-listing endpoint.
 * Stored DB snapshots are already normalized and must not be reparsed here.
 * A live source refresh opts into parsing + geo refinement so source coordinates
 * receive the same locationAccuracyM/provenance used by normal ingestion before
 * transport eligibility is evaluated.
 */
export async function preparePublicListing(listing, country, {refreshGeo = false} = {}) {
  if (!listing) return listing;
  let prepared = refreshGeo ? enrichListingDetails(listing) : {...listing};
  if (refreshGeo && country) {
    try {
      [prepared] = await geocodeListings([prepared], country);
    } catch (error) {
      console.warn('[listing-public] geo refinement failed:', error?.message ?? error);
    }
  }
  prepared = await attachMarketComparison(prepared);
  await attachTransport(prepared, country);
  return prepared;
}

export const __listingPublicTest = {
  hasFiniteCoordinate,
  hasFiniteCoordinates,
  TRANSIENT_DERIVED_FIELDS,
  RECOMPUTABLE_PARSED_FIELDS,
};
