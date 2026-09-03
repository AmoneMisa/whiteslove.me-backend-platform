// Turns a coordinate into "what is around here", using only rows already loaded
// from the places table. No network, no per-listing cost — a batch of listings
// shares one load and each one is a pass over an array.

const EARTH_RADIUS_M = 6_371_000;

// How far each kind is still worth mentioning. A supermarket 300 m away matters;
// a supermarket 2 km away is not "nearby". Landmarks and metro carry further —
// people describe a flat as being "at Tashkent City" from a fair distance.
const KIND_RADIUS_M = {
  metro: 2500,
  landmark: 3000,
  mall: 2000,
  supermarket: 900,
  market: 1500,
  pharmacy: 700,
  clinic: 1500,
  school: 1000,
  kindergarten: 800,
  park: 1200,
  historic: 2000,
  cinema: 2000,
  busStop: 600,
  railStation: 1500,
};

// Modes surfaced only through the nearbyTransport fallback (below), never as
// generic POI rows: transit stops read oddly next to a pharmacy or a school.
const TRANSPORT_FALLBACK_KINDS = Object.freeze({ busStop: 'bus', railStation: 'rail' });

const DEFAULT_RADIUS_M = 1000;
const LEGACY_PER_KIND = 3;
const LEGACY_FLAT_LIMIT = 15;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function distanceM(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Groups places by kind once per batch. Also keeps a flat list so a caller can
 * ask across kinds without re-walking the groups.
 */
export function indexPlaces(rows) {
  const byKind = new Map();
  for (const row of rows || []) {
    if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lng)) continue;
    const bucket = byKind.get(row.kind);
    if (bucket) bucket.push(row);
    else byKind.set(row.kind, [row]);
  }
  return byKind;
}

/** The closest places of one kind, nearest first, within that kind's useful radius. */
export function nearestOfKind(point, index, kind, { limit = Number.POSITIVE_INFINITY, radiusM } = {}) {
  const rows = index.get(kind) || [];
  const max = radiusM ?? KIND_RADIUS_M[kind] ?? DEFAULT_RADIUS_M;
  const hits = [];

  for (const row of rows) {
    // Cheap rejection before the trigonometry: one degree of latitude is ~111 km,
    // and at Tashkent's latitude a degree of longitude is ~83 km.
    if (Math.abs(row.lat - point.lat) * 111_000 > max) continue;
    if (Math.abs(row.lng - point.lng) * 83_000 > max) continue;

    const distance = distanceM(point, row);
    if (distance <= max) {
      hits.push({
        name: row.name,
        nameRu: row.nameRu || null,
        kind,
        distanceM: Math.round(distance),
        source: row.source || null,
        externalId: row.externalId || row.external_id || null,
      });
    }
  }

  // OSM carries a node per platform and per entrance, so one place can appear
  // several times under the same name. Keep the closest representation.
  const byName = new Map();
  for (const hit of hits.sort((a, b) => a.distanceM - b.distanceM)) {
    const key = hit.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, hit);
  }

  const values = [...byName.values()];
  return Number.isFinite(limit) ? values.slice(0, Math.max(0, Math.floor(limit))) : values;
}

/**
 * Everything worth naming around a point, grouped by kind and flattened into a
 * distance-sorted list for storage. Display callers can apply their own limit.
 */
export function placesNear(point, index, { perKind = Number.POSITIVE_INFINITY, kinds } = {}) {
  const wanted = kinds || [...index.keys()];
  const grouped = {};
  const flat = [];

  for (const kind of wanted) {
    const hits = nearestOfKind(point, index, kind, { limit: perKind });
    if (!hits.length) continue;
    grouped[kind] = hits;
    flat.push(...hits);
  }

  return { grouped, flat: flat.sort((a, b) => a.distanceM - b.distanceM) };
}

/**
 * Annotates one listing with its surroundings. Complete arrays are retained in
 * `nearbyPoi`/`nearbyPoiByKind`; legacy fields stay bounded for older clients.
 * Metro keeps its own compatibility fields until transport-catalog enrichment
 * supplies the canonical metro arrays.
 */
export function annotateListing(listing, index) {
  if (!Number.isFinite(listing?.lat) || !Number.isFinite(listing?.lng)) return false;
  const point = { lat: listing.lat, lng: listing.lng };

  const stations = nearestOfKind(point, index, 'metro');
  if (stations.length) {
    listing.metroNearby = stations.map(({ name, nameRu, distanceM: distance }) => ({
      name,
      nameRu,
      distanceM: distance,
    }));
    if (!listing.metro) {
      listing.metro = stations[0].name;
      listing.metroSource = 'coordinates';
      listing.metroDistanceM = stations[0].distanceM;
    }
  }

  const poiKinds = [...index.keys()].filter(
    (kind) => kind !== 'metro' && !(kind in TRANSPORT_FALLBACK_KINDS),
  );
  const { grouped, flat } = placesNear(point, index, { kinds: poiKinds });

  if (flat.length) {
    listing.nearbyPoi = flat;
    listing.nearbyPoiByKind = grouped;
    listing.poiSource = 'coordinates';

    // Backward-compatible bounded views for current clients.
    const legacyGrouped = {};
    for (const [kind, hits] of Object.entries(grouped)) {
      legacyGrouped[kind] = hits.slice(0, LEGACY_PER_KIND);
    }
    listing.nearbyPlaces = flat.slice(0, LEGACY_FLAT_LIMIT);
    listing.nearbyByKind = legacyGrouped;
    listing.landmarksNearby = (grouped.landmark || []).slice(0, LEGACY_PER_KIND);
    listing.placesSource = 'coordinates';
  }

  return Boolean(stations.length || flat.length);
}

/** Annotates a whole batch from one loaded place list. */
export function annotateListings(listings, rows) {
  const index = indexPlaces(rows);
  if (!index.size) return 0;
  let annotated = 0;
  for (const listing of listings || []) {
    if (annotateListing(listing, index)) annotated += 1;
  }
  return annotated;
}

function parseOsmId(externalId) {
  if (!externalId) return null;
  const [type, idPart] = String(externalId).split('/');
  const id = Number(idPart);
  if (!type || !Number.isFinite(id)) return null;
  return { type, id };
}

/**
 * Fills `nearbyTransport` from Overpass-sourced bus/rail stops, but only when
 * nothing richer got there first. The geo-catalog transport module (mode-aware,
 * carries route data) is Tashkent-only today; everywhere else this is the only
 * transit-stop source a listing has, so it fills the same field the frontend
 * already reads rather than adding a parallel one.
 */
export function annotateTransportFallback(listing, index) {
  if (!Number.isFinite(listing?.lat) || !Number.isFinite(listing?.lng)) return false;
  if (Array.isArray(listing.nearbyTransport) && listing.nearbyTransport.length) return false;
  const point = { lat: listing.lat, lng: listing.lng };

  const hits = Object.entries(TRANSPORT_FALLBACK_KINDS).flatMap(([kind, mode]) =>
    nearestOfKind(point, index, kind).map((hit) => ({
      id: hit.externalId || `${kind}:${hit.name}`,
      name: hit.name,
      mode,
      distanceM: hit.distanceM,
      routeRefs: [],
      geoEntityId: null,
      osm: parseOsmId(hit.externalId),
      source: hit.source || 'overpass',
    })),
  );
  if (!hits.length) return false;

  listing.nearbyTransport = hits.sort((a, b) => a.distanceM - b.distanceM);
  listing.transportSource = listing.transportSource || 'overpass';
  return true;
}

/** Batch form of annotateTransportFallback from one loaded place list. */
export function annotateTransportFallbackList(listings, rows) {
  const index = indexPlaces(rows);
  if (!index.size) return 0;
  let annotated = 0;
  for (const listing of listings || []) {
    if (annotateTransportFallback(listing, index)) annotated += 1;
  }
  return annotated;
}
