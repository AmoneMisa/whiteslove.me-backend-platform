import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {parseListingFilters} from '../src/listing-routes.js';
import {
  buildMemberWhere,
  canUseFastFeedPath,
} from '../src/postgres-search-fast-core.js';

const base = {
  customSources: [],
  propertyType: 'any',
  dealType: 'any',
  agency: 'any',
  audience: 'any',
  sources: [],
  sort: 'newest',
  limit: 20,
  offset: 0,
  maxAgeDays: 14,
  includeStats: false,
  statsOnly: false,
  mapOnly: false,
  listingId: '',
  query: '',
};

test('roomRent is canonical at the HTTP filter boundary', () => {
  assert.equal(parseListingFilters({dealType: 'roomRent'}).dealType, 'roomRent');

  const legacy = parseListingFilters({dealType: 'longRent', roomOnly: '1'});
  assert.equal(legacy.dealType, 'roomRent');
  assert.equal(legacy.roomOnly, null);
});

test('ordinary structured filters stay on the public-feed fast path', () => {
  assert.equal(canUseFastFeedPath({
    ...base,
    dealType: 'roomRent',
    agency: 'owner',
    propertyType: 'flat',
    priceMin: 300,
    priceMax: 800,
    priceCurrency: 'USD',
    roomsMin: 1,
    areaMin: 25,
    city: 'Tashkent',
    district: 'Mirobod',
    microdistrict: 'Oybek',
    metro: 'Oybek',
    metroMaxM: 900,
    pets: true,
    noCommission: true,
  }, null), true);

  assert.equal(canUseFastFeedPath({...base, query: 'near metro'}, null), false);
  assert.equal(canUseFastFeedPath({...base, customSources: ['https://example.com']}, null), false);
  assert.equal(canUseFastFeedPath({...base, includeStats: true}, null), false);
  assert.equal(canUseFastFeedPath({...base, sort: 'priceAsc'}, null), false);
});

test('fast member SQL covers scalar, relation, boolean and spatial filters', () => {
  const filters = {
    ...base,
    sources: ['olx'],
    propertyType: 'flat',
    dealType: 'longRent',
    agency: 'owner',
    audience: 'family',
    priceMin: 500,
    priceMax: 1000,
    priceCurrency: 'USD',
    roomsMin: 2,
    roomsMax: 3,
    areaMin: 40,
    areaMax: 90,
    bedroomsMin: 1,
    floorMin: 2,
    totalFloorsMax: 16,
    yearMin: 2010,
    pricePerSqmMax: 30,
    city: 'Tashkent',
    district: 'Mirobod',
    microdistrict: 'Oybek',
    quartal: '1-kvartal',
    area: 'city center',
    metro: 'Oybek',
    metroMaxM: 800,
    nearbyKind: 'school',
    nearbyMaxM: 1000,
    centerLat: 41.31,
    centerLng: 69.28,
    radiusM: 2500,
    pets: true,
    children: true,
    parking: true,
    noElevator: true,
    noDeposit: true,
    communalIncluded: true,
    noCommission: true,
    commissionPercentMax: 20,
    withPhotos: true,
  };

  const {where, params} = buildMemberWhere({
    filters,
    countries: ['UZ'],
    maxAgeDays: 14,
    rates: {USD: 1, UZS: 12500},
  });

  assert.ok(params.length > 10);
  assert.match(where, /m\.country = ANY/);
  assert.match(where, /m\.source = ANY/);
  assert.match(where, /m\.property_type =/);
  assert.match(where, /m\.deal_type =/);
  assert.match(where, /m\.by_agency = FALSE/);
  assert.match(where, /UPPER\(m\.currency\)/);
  assert.match(where, /m\.rooms >=/);
  assert.match(where, /m\.area_sqm >=/);
  assert.match(where, /m\.bedrooms >=/);
  assert.match(where, /m\.floor_number >=/);
  assert.match(where, /m\.building_year >=/);
  assert.match(where, /listing_location_terms/);
  assert.match(where, /listing_nearby_places/);
  assert.match(where, /m\.metro_distance_m <=/);
  assert.match(where, /m\.pets_allowed = TRUE/);
  assert.match(where, /m\.children_allowed IS DISTINCT FROM FALSE/);
  assert.match(where, /m\.parking = TRUE/);
  assert.match(where, /m\.elevator = FALSE/);
  assert.match(where, /m\.deposit = FALSE/);
  assert.match(where, /m\.communal_separated = FALSE/);
  assert.match(where, /m\.commission = FALSE OR m\.commission_percent = 0/);
  assert.match(where, /m\.has_photos = TRUE/);
  assert.match(where, /ACOS/);
});

test('read-model migrations materialize hot filters and tune indexes for city-first DISTINCT ON', async () => {
  const readModelMigration = await readFile(
    new URL('../migrations/034_public_feed_search_read_model.sql', import.meta.url),
    'utf8',
  );
  const indexMigration = await readFile(
    new URL('../migrations/035_public_feed_index_tuning.sql', import.meta.url),
    'utf8',
  );

  for (const column of [
    'property_type', 'deal_type', 'city', 'district', 'metro', 'by_agency',
    'price', 'currency', 'rooms', 'area_sqm', 'bedrooms', 'floor_number',
    'building_year', 'commission_percent', 'metro_distance_m', 'lat', 'lng',
    'pets_allowed', 'children_allowed', 'has_photos',
  ]) {
    assert.match(readModelMigration, new RegExp(`\\b${column}\\b`));
  }

  assert.match(readModelMigration, /CREATE OR REPLACE FUNCTION sync_listing_public_feed_member/);
  assert.match(readModelMigration, /listing_public_feed_members_country_lat_lng_idx/);

  assert.match(indexMigration, /DROP INDEX IF EXISTS listing_public_feed_members_country_deal_freshness_idx/);
  assert.match(indexMigration, /country_deal_dedupe_idx[\s\S]*country,[\s\S]*deal_type,[\s\S]*dedupe_key,[\s\S]*created_at DESC NULLS LAST/u);
  assert.match(indexMigration, /country_city_deal_dedupe_idx[\s\S]*country,[\s\S]*city,[\s\S]*deal_type,[\s\S]*dedupe_key/u);
  assert.match(indexMigration, /country_city_deal_owner_dedupe_idx[\s\S]*country,[\s\S]*city,[\s\S]*deal_type,[\s\S]*by_agency,[\s\S]*dedupe_key/u);
  assert.match(indexMigration, /country_city_deal_currency_price_idx[\s\S]*country,[\s\S]*city,[\s\S]*deal_type,[\s\S]*UPPER\(currency\),[\s\S]*price/u);
  assert.doesNotMatch(indexMigration, /CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_source_dedupe_idx/u);
  assert.match(indexMigration, /INCLUDE \(freshness_at\)/u);
});

test('production EXPLAIN harness is read-only and bounded', async () => {
  const explain = await readFile(
    new URL('../scripts/explain-public-feed.sql', import.meta.url),
    'utf8',
  );

  assert.match(explain, /EXPLAIN \(ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF\)/u);
  assert.match(explain, /SET LOCAL statement_timeout = '20s'/u);
  assert.match(explain, /listing_public_feed_members/u);
  assert.match(explain, /UPPER\(m\.currency\)/u);
  assert.match(explain, /ROLLBACK;/u);
  assert.doesNotMatch(explain, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/u);
});
