// District colour zones for the map's choropleth-style district overlay.
// Ports whiteslove.me's app/composables/flats/useDistrictZones.ts district
// logic to the server so the mobile app can render the same colours/shapes
// without needing a geo-catalog client of its own (Dart can't import it).
import { findGeoEntities, resolveLexiconGeoEntity } from '@whiteslove/geo-catalog';

// Keep in sync with ZONE_PALETTE in the site's useDistrictZones.ts.
export const ZONE_PALETTE = Object.freeze(['#e0679a', '#24a7d6', '#10b981', '#d99a0b', '#8b5cf6']);

const EARTH_RADIUS_M = 6371000;

function distanceM(a, b) {
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Radius is only used for entities that have no real boundary polygon.
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

function zoneFromEntity(entity, index) {
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
  };
}

function descendantsOf(cityId, country, type) {
  if (!cityId) return [];
  const prefix = `${cityId}:`;
  return findGeoEntities({country, type}).filter(
    (entity) => entity.parentId === cityId || entity.id.startsWith(prefix),
  );
}

/**
 * District colour zones for one city, matching the site's map exactly:
 * each administrative district gets a stable palette colour cycling through
 * ZONE_PALETTE, and its real OSM boundary polygon when the catalog has one
 * (falling back to a non-overlapping circle radius otherwise).
 */
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

/**
 * All of a city's map zone layers at once: administrative districts,
 * microdistricts, mahallas ("quartals"), local/development areas, and metro
 * stations. Every canonical entity carries its catalog `type` and `parentId`
 * so Flutter can apply nested scopes without replacing broader filters.
 */
export function mapZonesFor(countryCode, cityName, districtOptions = []) {
  const country = String(countryCode || '').toUpperCase();
  if (!country || !cityName) {
    return {
      districtZones: [],
      microdistrictMarkers: [],
      quartalMarkers: [],
      areaZones: [],
      metroStations: [],
      parks: [],
      shoppingMalls: [],
      universities: [],
      cityZone: null,
    };
  }

  const cityEntity = resolveLexiconGeoEntity({country, type: 'city', canonical: cityName});
  const cityId = cityEntity?.id ?? null;

  const districtZones = districtZonesFor(country, cityName, districtOptions);

  const microdistrictMarkers = descendantsOf(cityId, country, 'microdistrict')
    .map((entity, index) => zoneFromEntity(entity, index));

  const quartalMarkers = descendantsOf(cityId, country, 'mahalla')
    .map((entity, index) => zoneFromEntity(entity, index));

  const areaEntities = [
    ...descendantsOf(cityId, country, 'local_area'),
    ...descendantsOf(cityId, country, 'development_area'),
  ];
  const areaZones = fitNonOverlappingRadii(
    areaEntities.map((entity, index) => zoneFromEntity(entity, index)),
    150,
    700,
  );

  // Metro proximity rings are a Flat Finder presentation concern; station
  // identity and coordinates remain canonical geo-catalog data.
  const metroStations = descendantsOf(cityId, country, 'metro')
    .map((entity, index) => zoneFromEntity(entity, index));

  // Canonical POI identity, coordinates, hierarchy and boundaries remain
  // geo-catalog data. Flat Finder owns only their product presentation.
  const parks = descendantsOf(cityId, country, 'poi.park')
    .map((entity, index) => zoneFromEntity(entity, index));
  const shoppingMalls = descendantsOf(cityId, country, 'poi.shopping_mall')
    .map((entity, index) => zoneFromEntity(entity, index));
  const universities = descendantsOf(cityId, country, 'poi.university')
    .map((entity, index) => zoneFromEntity(entity, index));

  const cityZone = cityEntity ? zoneFromEntity(cityEntity, 0) : null;
  return {
    districtZones,
    microdistrictMarkers,
    quartalMarkers,
    areaZones,
    metroStations,
    parks,
    shoppingMalls,
    universities,
    cityZone,
  };
}
