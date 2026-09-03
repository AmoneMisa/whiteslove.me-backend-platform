import {pool} from '../database/pool.js';
// This module owns two things: the exact single-listing lookup below, and the
// filter contract (canUseFastFeedPath / buildMemberWhere) that the canonical
// feed in ../../support/postgres-canonical-feed.js reads listing_public_feed_members
// through. Everything else -- statistics, maps, custom-source queries,
// free-text search and non-feed sort modes -- falls through to the general
// implementation.
import {searchPostgresListings as searchPostgresListingsGeneral} from './postgres-search-core.js';

const MAX_AGE_DAYS = 14;
const EARTH_RADIUS_M = 6_371_000;

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function safeRateEntries(rates) {
  return Object.entries(rates || {})
    .map(([currency, rate]) => [String(currency).toUpperCase(), Number(rate)])
    .filter(([currency, rate]) => /^[A-Z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0);
}

function priceToUsd(value, currency, rates) {
  if (value == null) return null;
  const rate = Number(rates?.[String(currency || '').toUpperCase()]);
  return Number.isFinite(rate) && rate > 0 ? Number(value) / rate : null;
}

const NUMERIC_FILTERS = [
  'priceMin', 'priceMax', 'priceTolerance', 'roomsMin', 'roomsMax',
  'bedroomsMin', 'bedroomsMax', 'areaMin', 'areaMax', 'metroMaxM',
  'nearbyMaxM', 'pricePerSqmMin', 'pricePerSqmMax', 'floorMin', 'floorMax',
  'totalFloorsMin', 'totalFloorsMax', 'yearMin', 'yearMax',
  'commissionPercentMin', 'commissionPercentMax',
  'centerLat', 'centerLng', 'radiusM',
];

const BOOLEAN_FILTERS = [
  'newBuilding', 'dishwasher', 'airConditioner', 'parking', 'internet', 'gas',
  'balcony', 'terrace', 'privateYard', 'pets', 'children', 'roomOnly', 'withPhotos',
  'noElevator', 'noDeposit', 'communalIncluded', 'noCommission',
  'tv', 'microwave', 'oven', 'bidet', 'walkInCloset', 'bathtub', 'shower', 'euroLayout',
];

function hasSecondaryFilters(filters) {
  if (
    filters.customSources?.length || filters.query || filters.city || filters.district ||
    filters.microdistrict || filters.quartal || filters.area || filters.metro
  ) return true;
  if (filters.propertyType && filters.propertyType !== 'any') return true;
  if (filters.dealType && filters.dealType !== 'any') return true;
  if (filters.agency && filters.agency !== 'any') return true;
  if (filters.audience && filters.audience !== 'any') return true;
  if (NUMERIC_FILTERS.some((key) => hasValue(filters[key]))) return true;
  if (filters.priceCurrency || filters.nearbyKind) return true;
  return BOOLEAN_FILTERS.some((key) => filters[key] === true);
}

export function canUseFastListingPath(filters, countries, searchMatches) {
  if (!filters.listingId || searchMatches) return false;
  if (filters.includeStats || filters.statsOnly || filters.mapOnly) return false;
  if (filters.sources?.length !== 1 || countries?.length !== 1) return false;
  return !hasSecondaryFilters(filters);
}

export function canUseFastFeedPath(filters, searchMatches) {
  if (searchMatches) return false;
  if (filters.includeStats || filters.statsOnly || filters.mapOnly) return false;
  if (filters.listingId) return false;
  if (filters.customSources?.length || filters.query) return false;
  if (filters.sort && !['newest', 'oldest'].includes(filters.sort)) return false;
  return true;
}

export function buildMemberWhere({filters, countries, maxAgeDays, rates}) {
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const countryValues = [...new Set((countries || [])
    .map((value) => String(value).toUpperCase())
    .filter(Boolean))];
  const ageDays = maxAgeDays != null && Number(maxAgeDays) > 0
    ? Math.min(Number(maxAgeDays), MAX_AGE_DAYS)
    : MAX_AGE_DAYS;

  const where = [
    `m.freshness_at >= NOW() - (${add(ageDays)}::double precision * INTERVAL '1 day')`,
  ];
  if (countryValues.length) {
    where.push(`m.country = ANY(${add(countryValues)}::text[])`);
  }
  if (filters.sources?.length) {
    where.push(`m.source = ANY(${add(filters.sources.map((value) => String(value).toLowerCase()))}::text[])`);
  }

  if (filters.propertyType && filters.propertyType !== 'any') {
    where.push(`m.property_type = ${add(filters.propertyType)}`);
  }
  if (filters.dealType && filters.dealType !== 'any') {
    where.push(`m.deal_type = ${add(filters.dealType)}`);
  }
  if (filters.agency === 'agency') where.push('m.by_agency = TRUE');
  if (filters.agency === 'owner') where.push('m.by_agency = FALSE');
  if (filters.audience && filters.audience !== 'any') {
    where.push(`m.audience = ${add(filters.audience)}`);
  }

  const effectiveMax = filters.priceMax != null
    ? Number(filters.priceMax) + Number(filters.priceTolerance || 0)
    : null;
  const rateEntries = safeRateEntries(rates);
  const convertPrices = rateEntries.length > 0 && filters.priceCurrency;
  let priceUsdExpr = 'm.price';
  if (rateEntries.length) {
    const cases = rateEntries
      .map(([currency, rate]) => `WHEN '${currency}' THEN m.price / ${rate}`)
      .join(' ');
    priceUsdExpr = `(CASE UPPER(m.currency) ${cases} ELSE NULL END)`;
  }

  if (filters.priceMin != null || effectiveMax != null) {
    if (convertPrices) {
      const minUsd = filters.priceMin != null
        ? priceToUsd(filters.priceMin, filters.priceCurrency, rates)
        : null;
      const maxUsd = effectiveMax != null
        ? priceToUsd(effectiveMax, filters.priceCurrency, rates)
        : null;
      const branches = [];
      for (const [currency, rate] of rateEntries) {
        const predicates = [`UPPER(m.currency) = '${currency}'`, 'm.price IS NOT NULL'];
        if (minUsd != null) predicates.push(`m.price >= ${add(minUsd * rate)}`);
        if (maxUsd != null) predicates.push(`m.price <= ${add(maxUsd * rate)}`);
        branches.push(`(${predicates.join(' AND ')})`);
      }
      if (branches.length) where.push(`(${branches.join(' OR ')})`);
    } else {
      if (filters.priceMin != null) where.push(`m.price >= ${add(Number(filters.priceMin))}`);
      if (effectiveMax != null) where.push(`m.price <= ${add(Number(effectiveMax))}`);
    }
  }

  if (filters.roomsMin != null) where.push(`m.rooms >= ${add(Number(filters.roomsMin))}`);
  if (filters.roomsMax != null) where.push(`m.rooms <= ${add(Number(filters.roomsMax))}`);
  if (filters.areaMin != null) where.push(`m.area_sqm >= ${add(Number(filters.areaMin))}`);
  if (filters.areaMax != null) where.push(`m.area_sqm <= ${add(Number(filters.areaMax))}`);
  if (filters.bedroomsMin != null) where.push(`m.bedrooms >= ${add(Number(filters.bedroomsMin))}`);
  if (filters.bedroomsMax != null) where.push(`m.bedrooms <= ${add(Number(filters.bedroomsMax))}`);
  if (filters.floorMin != null) where.push(`m.floor_number >= ${add(Number(filters.floorMin))}`);
  if (filters.floorMax != null) where.push(`m.floor_number <= ${add(Number(filters.floorMax))}`);
  if (filters.totalFloorsMin != null) where.push(`m.total_floors >= ${add(Number(filters.totalFloorsMin))}`);
  if (filters.totalFloorsMax != null) where.push(`m.total_floors <= ${add(Number(filters.totalFloorsMax))}`);
  if (filters.yearMin != null) where.push(`m.building_year >= ${add(Number(filters.yearMin))}`);
  if (filters.yearMax != null) where.push(`m.building_year <= ${add(Number(filters.yearMax))}`);
  if (filters.metroMaxM != null) where.push(`m.metro_distance_m <= ${add(Number(filters.metroMaxM))}`);

  if (filters.pricePerSqmMin != null || filters.pricePerSqmMax != null) {
    where.push('m.price IS NOT NULL AND m.area_sqm IS NOT NULL AND m.area_sqm > 0');
    const perSqm = convertPrices ? `(${priceUsdExpr} / m.area_sqm)` : '(m.price / m.area_sqm)';
    if (convertPrices) {
      const min = filters.pricePerSqmMin != null
        ? priceToUsd(filters.pricePerSqmMin, filters.priceCurrency, rates)
        : null;
      const max = filters.pricePerSqmMax != null
        ? priceToUsd(filters.pricePerSqmMax, filters.priceCurrency, rates)
        : null;
      if (min != null) where.push(`${perSqm} >= ${add(min)}`);
      if (max != null) where.push(`${perSqm} <= ${add(max)}`);
    } else {
      if (filters.pricePerSqmMin != null) where.push(`${perSqm} >= ${add(Number(filters.pricePerSqmMin))}`);
      if (filters.pricePerSqmMax != null) where.push(`${perSqm} <= ${add(Number(filters.pricePerSqmMax))}`);
    }
  }

  if (filters.newBuilding === true) where.push('m.new_building = TRUE');
  if (filters.pets === true) where.push('m.pets_allowed = TRUE');
  if (filters.children === true) where.push('m.children_allowed IS DISTINCT FROM FALSE');
  if (filters.roomOnly === true) where.push('m.room_only = TRUE');
  if (filters.withPhotos === true) where.push('m.has_photos = TRUE');

  const booleanFilters = [
    ['dishwasher', 'dishwasher'], ['airConditioner', 'air_conditioner'], ['parking', 'parking'], ['internet', 'internet'],
    ['gas', 'gas'], ['balcony', 'balcony'], ['terrace', 'terrace'], ['privateYard', 'private_yard'],
    ['tv', 'tv'], ['microwave', 'microwave'], ['oven', 'oven'], ['bidet', 'bidet'],
    ['walkInCloset', 'walk_in_closet'], ['bathtub', 'bathtub'], ['shower', 'shower'], ['euroLayout', 'euro_layout'],
  ];
  for (const [filterName, columnName] of booleanFilters) {
    if (filters[filterName] === true) where.push(`m.${columnName} = TRUE`);
  }

  if (filters.noElevator === true) where.push('m.elevator = FALSE');
  if (filters.noDeposit === true) where.push('m.deposit = FALSE');
  if (filters.communalIncluded === true) where.push('m.communal_separated = FALSE');
  if (filters.noCommission === true) {
    where.push('(m.commission = FALSE OR m.commission_percent = 0)');
  }
  if (filters.commissionPercentMin != null) {
    where.push(`m.commission_percent >= ${add(Number(filters.commissionPercentMin))}`);
  }
  if (filters.commissionPercentMax != null) {
    where.push(`m.commission_percent <= ${add(Number(filters.commissionPercentMax))}`);
  }

  if (filters.city) where.push(`m.city = ${add(String(filters.city))}`);
  if (filters.district) where.push(`LOWER(m.district) = ${add(String(filters.district).toLowerCase())}`);
  if (filters.metro) where.push(`LOWER(m.metro) = ${add(String(filters.metro).toLowerCase())}`);

  if (filters.microdistrict) {
    const value = add(String(filters.microdistrict).trim().toLowerCase());
    where.push(`EXISTS (
      SELECT 1 FROM listing_location_terms term
      WHERE term.listing_id = m.listing_id
        AND term.normalized_name = ${value}
        AND term.term_type = 'microdistrict'
    )`);
  }
  if (filters.quartal) {
    const value = add(String(filters.quartal).trim().toLowerCase());
    where.push(`EXISTS (
      SELECT 1 FROM listing_location_terms term
      WHERE term.listing_id = m.listing_id
        AND term.normalized_name = ${value}
        AND term.term_type IN ('quartal', 'local_area', 'mahalla')
    )`);
  }
  if (filters.area) {
    const value = add(String(filters.area).trim().toLowerCase());
    where.push(`EXISTS (
      SELECT 1 FROM listing_location_terms term
      WHERE term.listing_id = m.listing_id
        AND term.normalized_name = ${value}
        AND term.term_type IN ('area', 'local_area', 'development_area', 'informal_area')
    )`);
  }

  if (filters.nearbyKind || filters.nearbyMaxM != null) {
    const placeChecks = ['place.listing_id = m.listing_id'];
    if (filters.nearbyKind) {
      placeChecks.push(`place.kind = ${add(String(filters.nearbyKind).trim().toLowerCase())}`);
    }
    if (filters.nearbyMaxM != null) {
      placeChecks.push(`place.distance_m <= ${add(Number(filters.nearbyMaxM))}`);
    }
    where.push(`EXISTS (
      SELECT 1 FROM listing_nearby_places place
      WHERE ${placeChecks.join(' AND ')}
    )`);
  }

  if (Number.isFinite(filters.centerLat) && Number.isFinite(filters.centerLng)
    && Number.isFinite(filters.radiusM) && filters.centerLat >= -90 && filters.centerLat <= 90
    && filters.centerLng >= -180 && filters.centerLng <= 180 && filters.radiusM > 0) {
    const centerLat = Number(filters.centerLat);
    const centerLng = Number(filters.centerLng);
    const radiusM = Math.min(Number(filters.radiusM), 200000);
    const centerLatRad = centerLat * Math.PI / 180;
    const angularRadius = radiusM / EARTH_RADIUS_M;
    const latDelta = angularRadius * 180 / Math.PI;
    const minLat = Math.max(-90, centerLat - latDelta);
    const maxLat = Math.min(90, centerLat + latDelta);
    where.push('m.lat IS NOT NULL AND m.lng IS NOT NULL');
    where.push(`m.lat BETWEEN ${add(minLat)} AND ${add(maxLat)}`);

    if (Math.abs(centerLatRad) + angularRadius < Math.PI / 2) {
      const ratio = Math.min(1, Math.sin(angularRadius) / Math.cos(centerLatRad));
      const lngDelta = Math.asin(ratio) * 180 / Math.PI;
      const minLng = centerLng - lngDelta;
      const maxLng = centerLng + lngDelta;
      if (minLng >= -180 && maxLng <= 180) {
        where.push(`m.lng BETWEEN ${add(minLng)} AND ${add(maxLng)}`);
      } else if (minLng < -180) {
        where.push(`(m.lng >= ${add(minLng + 360)} OR m.lng <= ${add(maxLng)})`);
      } else {
        where.push(`(m.lng >= ${add(minLng)} OR m.lng <= ${add(maxLng - 360)})`);
      }
    }

    const lat = add(centerLat);
    const lng = add(centerLng);
    const radius = add(radiusM);
    where.push(`${EARTH_RADIUS_M} * ACOS(LEAST(1, GREATEST(-1,
      COS(RADIANS(${lat})) * COS(RADIANS(m.lat)) * COS(RADIANS(m.lng) - RADIANS(${lng}))
      + SIN(RADIANS(${lat})) * SIN(RADIANS(m.lat))))) <= ${radius}`);
  }

  return {
    params,
    where: where.join('\n      AND '),
  };
}

async function timedQuery(sql, params) {
  const startedAt = performance.now();
  const result = await pool.query(sql, params);
  return {
    result,
    ms: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

async function searchExactListing({filters, countries}) {
  const startedAt = performance.now();
  const ageDays = filters.maxAgeDays != null && Number(filters.maxAgeDays) > 0
    ? Math.min(Number(filters.maxAgeDays), MAX_AGE_DAYS)
    : MAX_AGE_DAYS;
  const query = await timedQuery(`
    SELECT l.id AS db_id, l.created_at, l.data
    FROM listings l
    WHERE l.source = $1
      AND l.country = $2
      AND l.source_id = $3
      AND l.active = TRUE
      AND l.listing_kind <> 'propertyWanted'
      AND l.listing_status NOT IN ('sold', 'rented', 'closed', 'outdated')
      AND NOT l.commercial
      AND (l.created_at IS NULL OR l.created_at >= NOW() - ($4::double precision * INTERVAL '1 day'))
    LIMIT 1
  `, [filters.sources[0], countries[0], String(filters.listingId), ageDays]);
  const row = query.result.rows[0];

  return {
    count: row ? 1 : 0,
    listings: row ? [row.data || {}] : [],
    nextCursor: null,
    countMs: 0,
    pageMs: query.ms,
    queryMs: Math.round((performance.now() - startedAt) * 10) / 10,
    searchPath: 'postgres-listing-id',
  };
}

export async function searchPostgresListings(args) {
  if (canUseFastListingPath(args.filters, args.countries, args.searchMatches)) {
    return searchExactListing(args);
  }
  return searchPostgresListingsGeneral(args);
}
