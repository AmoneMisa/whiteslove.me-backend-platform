import {enrichListingDetails} from '../listing/listing-enrichment.js';
import {attachContactActions, attachListingLines} from '../listing/listing-contact-actions.js';
import {loadStoredListingLines} from '../infrastructure/database/listingLineRepository.js';
import {geocodeListings} from '../geo/geocode.js';
import {getRates} from '../support/fx.js';
import {attachMarketComparisons} from '../geo/market-comparison.js';
import {annotateNearbyTransport} from '../geo/transport-nearby.js';

const TRANSIENT_DERIVED_FIELDS = [
  'nearbyMetro',
  'nearbyTransport',
  'metroNearby',
  'metroSource',
  'metroDistanceM',
  'metroWalkingDistanceM',
  'metroWalkingDurationMin',
  'transportSource',
  'walkingRouteSource',
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

// A single-listing response opens the popup. Market comparison, transport and
// contact lines only decorate it, so each gets a bounded slice of time: a slow
// comparison query or pedestrian router must degrade to a listing without that
// decoration, never to a lookup that outlives the web tier's 8s timeout (which
// made shared ?adv= links fail to open at all).
const ENRICHMENT_BUDGET_MS = Math.max(
  250,
  Number(process.env.LISTING_PUBLIC_ENRICHMENT_BUDGET_MS) || 2_500,
);

async function withinBudget(label, work, fallback, budgetMs = ENRICHMENT_BUDGET_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[listing-public] ${label} exceeded ${budgetMs}ms; responding without it`);
      resolve(fallback);
    }, budgetMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(work).catch((error) => {
        console.warn(`[listing-public] ${label} failed:`, error?.message ?? error);
        return fallback;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function marketComparisonFor(listing) {
  const {rates} = await getRates();
  const [withMarket] = await attachMarketComparisons([listing], rates);
  return withMarket?.marketComparison;
}

// Transport annotates in place, so it works on a copy: a run that finishes
// after its budget must not mutate the listing already being serialized.
async function transportFor(listing, country) {
  if (!listing || !country) return null;
  const copy = {...listing};
  await annotateNearbyTransport([copy], country);
  const fields = {};
  for (const [key, value] of Object.entries(copy)) {
    if (listing[key] !== value) fields[key] = value;
  }
  return fields;
}

/**
 * Final response pipeline shared by every single-listing endpoint.
 * Stored DB snapshots are already normalized and must not be reparsed here.
 * A live source refresh opts into parsing + geo refinement so source coordinates
 * receive the same locationAccuracyM/provenance used by normal ingestion before
 * transport eligibility is evaluated.
 */
export async function preparePublicListing(listing, country, {refreshGeo = false, budgetMs = ENRICHMENT_BUDGET_MS} = {}) {
  if (!listing) return listing;
  let prepared = refreshGeo ? enrichListingDetails(listing) : {...listing};
  if (refreshGeo && country) {
    prepared = await withinBudget('geo refinement', async () => {
      const [geocoded] = await geocodeListings([prepared], country);
      return geocoded || prepared;
    }, prepared, budgetMs);
  }
  const [marketComparison, transport] = await Promise.all([
    withinBudget('market comparison', () => marketComparisonFor(prepared), undefined, budgetMs),
    withinBudget('transport enrichment', () => transportFor(prepared, country), null, budgetMs),
  ]);
  prepared = {
    ...prepared,
    ...(transport || {}),
    ...(marketComparison !== undefined ? {marketComparison} : {}),
  };
  const [withLine] = await withinBudget(
    'listing lines',
    () => attachListingLines([attachContactActions(prepared)], {loadLines: loadStoredListingLines}),
    [attachContactActions(prepared)],
    budgetMs,
  );
  return withLine;
}

export const __listingPublicTest = {
  withinBudget,
  hasFiniteCoordinate,
  hasFiniteCoordinates,
  TRANSIENT_DERIVED_FIELDS,
  RECOMPUTABLE_PARSED_FIELDS,
};
