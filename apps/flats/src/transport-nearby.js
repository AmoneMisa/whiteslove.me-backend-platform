const MAX_ACCURACY_M = 800;
const METRO_RADIUS_M = 2500;
const TRANSPORT_RADIUS_M = 1000;

let transportModulePromise;

async function loadTransportModule() {
  if (!transportModulePromise) {
    transportModulePromise = import('@whiteslove/geo-catalog/transport').catch((error) => {
      if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'ERR_MODULE_NOT_FOUND') {
        console.warn('[transport] geo-catalog transport subpath unavailable:', error?.message || error);
      }
      return null;
    });
  }
  return transportModulePromise;
}

function compactHit(hit) {
  const stop = hit.stop;
  return {
    id: stop.id,
    name: stop.canonicalName,
    mode: stop.mode,
    distanceM: hit.distanceM,
    routeRefs: [...(hit.routeRefs || [])],
    geoEntityId: stop.geoEntityId || null,
    osm: stop.osm || null,
    source: stop.source || null,
  };
}

function eligibleListing(listing, country) {
  if (!listing || String(country?.code || listing.country || '').toUpperCase() !== 'UZ') return false;
  if (!Number.isFinite(listing.lat) || !Number.isFinite(listing.lng)) return false;
  if ((listing.locationAccuracyM ?? Number.POSITIVE_INFINITY) > MAX_ACCURACY_M) return false;
  const city = String(listing.city || country?.cities?.[0] || '');
  return !city || city === 'Tashkent';
}

export function annotateNearbyTransportWithCatalog(listings, country, transport) {
  if (!Array.isArray(listings) || !listings.length || !transport?.nearestTransportStops) return 0;

  let annotated = 0;
  for (const listing of listings) {
    if (!eligibleListing(listing, country)) continue;
    const point = { lat: listing.lat, lng: listing.lng };

    const metro = transport.nearestTransportStops(point, {
      country: 'UZ',
      cityId: 'uz:tashkent',
      mode: 'metro',
      maxDistanceM: METRO_RADIUS_M,
    }).map(compactHit);

    const nearby = transport.nearestTransportStops(point, {
      country: 'UZ',
      cityId: 'uz:tashkent',
      maxDistanceM: TRANSPORT_RADIUS_M,
    })
      .filter((hit) => hit.stop.mode !== 'metro')
      .map(compactHit);

    if (metro.length) {
      listing.nearbyMetro = metro;
      listing.metroNearby = metro.map(({ name, distanceM }) => ({ name, nameRu: null, distanceM }));
      if (!listing.metro) {
        listing.metro = metro[0].name;
        listing.metroSource = 'coordinates';
        listing.metroDistanceM = metro[0].distanceM;
      }
    }

    if (nearby.length) listing.nearbyTransport = nearby;

    if (metro.length || nearby.length) {
      listing.transportSource = 'geo-catalog';
      annotated += 1;
    }
  }

  return annotated;
}

/**
 * Adds complete nearby transit arrays from geo-catalog. The old single `metro`
 * field remains the closest metro fallback for backwards compatibility.
 */
export async function annotateNearbyTransport(listings, country) {
  if (!Array.isArray(listings) || !listings.length) return 0;
  const transport = await loadTransportModule();
  const annotated = annotateNearbyTransportWithCatalog(listings, country, transport);
  if (annotated) console.log(`[transport] nearby transit annotated: ${annotated}/${listings.length}`);
  return annotated;
}

export const __transportNearbyTest = {
  compactHit,
  eligibleListing,
  METRO_RADIUS_M,
  TRANSPORT_RADIUS_M,
};
