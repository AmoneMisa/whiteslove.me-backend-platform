// District colour zones for the map's choropleth-style district overlay.
// Ports whiteslove.me's app/composables/flats/useDistrictZones.ts district
// logic to the server so the mobile app can render the same colours/shapes
// without needing a geo-catalog client of its own (Dart can't import it).
import {findGeoEntities, resolveLexiconGeoEntity} from '@whiteslove/geo-catalog';
import {findTransportRoutes, findTransportStops} from '@whiteslove/geo-catalog/transport';

export const ZONE_PALETTE = Object.freeze(['#e0679a', '#24a7d6', '#10b981', '#d99a0b', '#8b5cf6']);

const METRO_LINE_COLORS = Object.freeze({
  Chilonzor: '#e53935',
  "O'zbekiston": '#1976d2',
  Yunusobod: '#2eaf5d',
  Circle: '#f2b705',
});
const TRANSPORT_MODE_COLORS = Object.freeze({
  bus: '#2563eb',
  tram: '#8b5cf6',
  trolleybus: '#0ea5e9',
  minibus: '#f59e0b',
  rail: '#64748b',
});

const EARTH_RADIUS_M = 6371000;

// geo-catalog data is immutable for the lifetime of a process. The old map
// adapter rescanned the complete catalog for every entity type, for every city,
// on every request. Keep those package-level scans once per process; the
// persisted read model means API requests normally do not execute this path at
// all, while snapshot rebuilds and tests remain bounded.
const entitiesByCountryType = new Map();
const descendantsCache = new Map();
const transportStopsCache = new Map();
const routeRefsCache = new Map();
let routeRefsIndexed = false;

function distanceM(a, b) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function fitNonOverlappingRadii(zones, min, max) {
  return zones.map((zone, index) => {
    if (zone.boundary) return zone;
    let nearest = Infinity;
    for (let other = 0; other < zones.length; other += 1) {
      if (other === index) continue;
      const d = distanceM(zone, zones[other]);
      if (d < nearest) nearest = d;
    }
    const neighborCap = Number.isFinite(nearest) ? (nearest / 2) * 0.9 : max;
    const radiusM = Math.max(min, Math.min(zone.radiusM, neighborCap, max));
    return {...zone, radiusM};
  });
}

function zoneFromEntity(entity, index, extra = {}) {
  return {
    id: entity.id,
    parentId: entity.parentId ?? null,
    type: entity.type,
    name: entity.canonicalName,
    lat: entity.center.lat,
    lng: entity.center.lng,
    radiusM: entity.accuracyM || 400,
    color: ZONE_PALETTE[index % ZONE_PALETTE.length],
    boundary: entity.boundary || null,
    ...extra,
  };
}

function entitiesForType(country, type) {
  const key = `${country}\0${type}`;
  if (!entitiesByCountryType.has(key)) {
    entitiesByCountryType.set(key, findGeoEntities({country, type}));
  }
  return entitiesByCountryType.get(key);
}

function descendantsOf(cityId, country, type) {
  if (!cityId) return [];
  const key = `${country}\0${cityId}\0${type}`;
  if (!descendantsCache.has(key)) {
    const prefix = `${cityId}:`;
    descendantsCache.set(
      key,
      entitiesForType(country, type).filter(
        (entity) => entity.parentId === cityId || entity.id.startsWith(prefix),
      ),
    );
  }
  return descendantsCache.get(key);
}

function cityTransportStops(country, cityId) {
  if (!cityId) return [];
  const key = `${country}\0${cityId}`;
  if (!transportStopsCache.has(key)) {
    transportStopsCache.set(key, findTransportStops({country, cityId}));
  }
  return transportStopsCache.get(key);
}

// geo-catalog's getRoutesForStop() scans the full route catalog on every call.
// A snapshot build asks for route refs for every stop, turning first-build cost
// into stops x routes. Build the inverse relation once instead. Iterating routes
// in catalog order and inserting refs into Sets preserves the previous result's
// first-seen ordering and de-duplication semantics.
function ensureRouteRefsIndex() {
  if (routeRefsIndexed) return;

  const refsByStop = new Map();
  for (const route of findTransportRoutes()) {
    const ref = String(route?.ref || '').trim();
    if (!ref) continue;

    const stopIds = new Set(route?.stopIds || []);
    for (const variant of route?.variants || []) {
      for (const stopId of variant?.stopIds || []) stopIds.add(stopId);
    }

    for (const stopId of stopIds) {
      const key = String(stopId || '');
      if (!key) continue;
      if (!refsByStop.has(key)) refsByStop.set(key, new Set());
      refsByStop.get(key).add(ref);
    }
  }

  for (const [stopId, refs] of refsByStop) {
    routeRefsCache.set(stopId, [...refs]);
  }
  routeRefsIndexed = true;
}

function routeRefsForStop(stopId) {
  ensureRouteRefsIndex();
  return routeRefsCache.get(String(stopId || '')) || [];
}

function metroPresentationByGeoEntity(cityId, country) {
  const byGeoEntity = new Map();
  if (!cityId) return byGeoEntity;
  for (const stop of cityTransportStops(country, cityId)) {
    if (stop.mode !== 'metro' || !stop.geoEntityId) continue;
    const routeRefs = routeRefsForStop(stop.id);
    const lineColors = [...new Set(routeRefs.map((ref) => METRO_LINE_COLORS[ref]).filter(Boolean))];
    byGeoEntity.set(stop.geoEntityId, {
      routeRefs,
      lineColors,
      lineColor: lineColors[0] || '#2563eb',
    });
  }
  return byGeoEntity;
}

function transportStopZone(stop) {
  return {
    id: stop.id,
    parentId: stop.cityId,
    type: 'transport_stop',
    mode: stop.mode,
    name: stop.canonicalName,
    lat: stop.center.lat,
    lng: stop.center.lng,
    radiusM: stop.accuracyM || 100,
    color: TRANSPORT_MODE_COLORS[stop.mode] || '#94a3b8',
    routeRefs: routeRefsForStop(stop.id),
    boundary: null,
  };
}

export function districtZonesFor(countryCode, cityName, districtOptions = []) {
  const country = String(countryCode || '').toUpperCase();
  if (!country || !cityName) return [];

  const cityEntity = resolveLexiconGeoEntity({country, type: 'city', canonical: cityName});
  const canonical = descendantsOf(cityEntity?.id ?? null, country, 'district');
  const entities = canonical.length
    ? canonical
    : districtOptions
      .map((name) => resolveLexiconGeoEntity({country, city: cityName, type: 'district', canonical: name}))
      .filter(Boolean);

  const zones = entities.map((entity, index) => zoneFromEntity(entity, index));
  return fitNonOverlappingRadii(zones, 350, 1800);
}

export function mapZonesFor(countryCode, cityName, districtOptions = []) {
  const country = String(countryCode || '').toUpperCase();
  if (!country || !cityName) {
    return {
      districtZones: [],
      regionZones: [],
      microdistrictMarkers: [],
      mahallaMarkers: [],
      quarterMarkers: [],
      quartalMarkers: [],
      zoneMarkers: [],
      areaZones: [],
      metroStations: [],
      parks: [],
      shoppingMalls: [],
      universities: [],
      schools: [],
      residentialComplexes: [],
      airports: [],
      railwayStations: [],
      busStations: [],
      transportStops: [],
      parkings: [],
      cityZone: null,
    };
  }

  const cityEntity = resolveLexiconGeoEntity({country, type: 'city', canonical: cityName});
  const cityId = cityEntity?.id ?? null;
  const regionZones = cityEntity?.parentId
    ? entitiesForType(country, 'region')
      .filter((entity) => entity.id === cityEntity.parentId)
      .map((entity, index) => zoneFromEntity(entity, index))
    : [];
  const districtZones = districtZonesFor(country, cityName, districtOptions);
  const microdistrictMarkers = descendantsOf(cityId, country, 'microdistrict')
    .map((entity, index) => zoneFromEntity(entity, index));

  const mahallaMarkers = descendantsOf(cityId, country, 'mahalla')
    .map((entity, index) => zoneFromEntity(entity, index));
  // geo-catalog intentionally models Uzbek mavze/quarter names as
  // microdistricts. Keep a distinct stable group without duplicating those
  // canonical entities under a second, misleading type.
  const quarterMarkers = [];

  const areaEntities = [
    ...descendantsOf(cityId, country, 'local_area'),
    ...descendantsOf(cityId, country, 'development_area'),
  ];
  const areaZones = fitNonOverlappingRadii(
    areaEntities.map((entity, index) => zoneFromEntity(entity, index)),
    150,
    700,
  );
  const zoneMarkers = areaZones;

  const metroMeta = metroPresentationByGeoEntity(cityId, country);
  const metroStations = descendantsOf(cityId, country, 'metro')
    .map((entity, index) => zoneFromEntity(entity, index, metroMeta.get(entity.id) || {}));

  const parks = descendantsOf(cityId, country, 'poi.park').map((entity, index) => zoneFromEntity(entity, index, {color: '#22c55e'}));
  const shoppingMalls = descendantsOf(cityId, country, 'poi.shopping_mall').map((entity, index) => zoneFromEntity(entity, index, {color: '#f97316'}));
  const universities = descendantsOf(cityId, country, 'poi.university').map((entity, index) => zoneFromEntity(entity, index, {color: '#8b5cf6'}));
  const schools = descendantsOf(cityId, country, 'poi.school').map((entity, index) => zoneFromEntity(entity, index, {color: '#ec4899'}));
  const residentialComplexes = descendantsOf(cityId, country, 'residential_complex').map((entity, index) => zoneFromEntity(entity, index, {color: '#14b8a6'}));
  const airports = descendantsOf(cityId, country, 'poi.airport').map((entity, index) => zoneFromEntity(entity, index, {color: '#0ea5e9'}));
  const railwayStations = descendantsOf(cityId, country, 'poi.railway_station').map((entity, index) => zoneFromEntity(entity, index, {color: '#64748b'}));
  const busStations = descendantsOf(cityId, country, 'poi.bus_station').map((entity, index) => zoneFromEntity(entity, index, {color: '#2563eb'}));
  const transportStops = cityTransportStops(country, cityId)
    .filter((stop) => ['bus', 'tram', 'trolleybus', 'minibus', 'rail'].includes(stop.mode))
    .map(transportStopZone);
  const parkings = [];

  const cityZone = cityEntity ? zoneFromEntity(cityEntity, 0) : null;
  return {
    districtZones,
    regionZones,
    microdistrictMarkers,
    mahallaMarkers,
    quarterMarkers,
    quartalMarkers: mahallaMarkers,
    areaZones,
    zoneMarkers,
    metroStations,
    parks,
    shoppingMalls,
    universities,
    schools,
    residentialComplexes,
    airports,
    railwayStations,
    busStations,
    transportStops,
    parkings,
    cityZone,
  };
}
