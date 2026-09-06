import {COUNTRY_CODES} from '../geo/countries.js';
import {canonicalCity} from '@whiteslove/parsing-lexicon/geography';
import {attachResolvedSearchGeometry} from '../geo/search-filter-geometry.js';
import {getRates} from '../support/fx.js';
import {refreshAll} from '../scheduling/scheduler.js';
import {searchPostgresListings} from '../support/postgres-search-fast.js';
import {searchPostgresMapPoints} from './map-feed.js';
import {attachMarketComparisons} from '../geo/market-comparison.js';
import {searchListingMatches} from '../infrastructure/search/elasticsearch.js';
import {checkRate} from '../support/request-rate-limit.js';
import {prepareCustomSources} from '../sources/custom-source-queue.js';

const LISTING_MAX_AGE_DAYS = 14;
const LISTING_PAGE_SIZE = 20;
const LISTING_MAX_PAGE_SIZE = 60;
const VALID_SOURCES = ['olx', 'telegram', 'facebook', 'threads'];
// Title ordering is deliberately absent: it is the only sort the public-feed
// read model cannot serve, so it forced the request onto the general search
// path and a full sort of the result set. Clients that still send it fall back
// to the default order rather than getting an error.
const VALID_SORTS = [
  'newest',
  'oldest',
  'priceAsc',
  'priceDesc',
];

export function parseListingFilters(q) {
  const num = (v) => {
    if (v == null || v === '') return null;
    const value = Number(v);
    return Number.isFinite(value) ? value : null;
  };
  const bool = (v) => (v === 'true' || v === '1' ? true : null);
  const sources = String(q.sources || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => VALID_SOURCES.includes(s));
  const customSources = [
    ...new Set(
      String(q.customSources || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s)),
    ),
  ].slice(0, 10);
  const metros = [
    ...new Set(
      String(q.metro || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const metroArcParts = String(q.metroArc || '')
    .split(',')
    .map((value) => Number(value.trim()));
  const metroArc = metroArcParts.length === 2 && metroArcParts.every(Number.isFinite)
    ? {from: metroArcParts[0], to: metroArcParts[1]}
    : null;
  const offset = Math.max(0, Math.trunc(num(q.offset) ?? 0));
  const limit = Math.max(
    1,
    Math.min(
      Math.trunc(num(q.limit) ?? LISTING_PAGE_SIZE),
      LISTING_MAX_PAGE_SIZE,
    ),
  );
  const requestedMaxAgeDays = num(q.maxAgeDays);
  const maxAgeDays = requestedMaxAgeDays != null && requestedMaxAgeDays > 0
    ? Math.min(requestedMaxAgeDays, LISTING_MAX_AGE_DAYS)
    : LISTING_MAX_AGE_DAYS;
  const requestedRoomOnly = bool(q.roomOnly);
  const requestedDealType = ['sale', 'longRent', 'shortRent', 'roomRent', 'any'].includes(q.dealType)
    ? q.dealType
    : 'any';
  // Backward compatibility for clients that still encode room rental as
  // longRent + roomOnly=1. From this boundary onward roomRent is canonical.
  const dealType = requestedDealType === 'longRent' && requestedRoomOnly === true
    ? 'roomRent'
    : requestedDealType;
  const roomOnly = dealType === 'roomRent' ? null : requestedRoomOnly;

  return {
    customSources,
    propertyType: ['flat', 'house', 'any'].includes(q.propertyType) ? q.propertyType : 'any',
    dealType,
    agency: ['owner', 'agency', 'any'].includes(q.agency) ? q.agency : 'any',
    audience: ['women', 'men', 'family', 'any'].includes(q.audience) ? q.audience : 'any',
    priceMin: num(q.priceMin),
    priceMax: num(q.priceMax),
    priceTolerance: num(q.priceTolerance),
    priceCurrency: q.priceCurrency ? String(q.priceCurrency).toUpperCase() : null,
    roomsMin: num(q.roomsMin),
    roomsMax: num(q.roomsMax),
    bedroomsMin: num(q.bedroomsMin),
    bedroomsMax: num(q.bedroomsMax),
    areaMin: num(q.areaMin),
    areaMax: num(q.areaMax),
    metroMaxM: num(q.metroMaxM),
    nearbyMaxM: num(q.nearbyMaxM),
    nearbyKind: q.nearbyKind ? String(q.nearbyKind).toLowerCase() : null,
    centerLat: num(q.centerLat),
    centerLng: num(q.centerLng),
    radiusM: num(q.radiusM),
    pricePerSqmMin: num(q.pricePerSqmMin),
    pricePerSqmMax: num(q.pricePerSqmMax),
    floorMin: num(q.floorMin),
    floorMax: num(q.floorMax),
    totalFloorsMin: num(q.totalFloorsMin),
    totalFloorsMax: num(q.totalFloorsMax),
    yearMin: num(q.yearMin),
    yearMax: num(q.yearMax),
    newBuilding: bool(q.newBuilding),
    dishwasher: bool(q.dishwasher),
    airConditioner: bool(q.airConditioner),
    parking: bool(q.parking),
    internet: bool(q.internet),
    gas: bool(q.gas),
    balcony: bool(q.balcony),
    terrace: bool(q.terrace),
    privateYard: bool(q.privateYard),
    tv: bool(q.tv),
    microwave: bool(q.microwave),
    oven: bool(q.oven),
    bidet: bool(q.bidet),
    walkInCloset: bool(q.walkInCloset),
    bathtub: bool(q.bathtub),
    shower: bool(q.shower),
    euroLayout: bool(q.euroLayout),
    noElevator: bool(q.noElevator),
    noDeposit: bool(q.noDeposit),
    communalIncluded: bool(q.communalIncluded),
    noCommission: bool(q.noCommission),
    commissionPercentMin: num(q.commissionPercentMin),
    commissionPercentMax: num(q.commissionPercentMax),
    sort: VALID_SORTS.includes(q.sort) ? q.sort : null,
    city: q.city ? String(q.city) : '',
    district: q.district ? String(q.district) : '',
    microdistrict: q.microdistrict ? String(q.microdistrict) : '',
    quartal: q.quartal ? String(q.quartal) : '',
    area: q.area ? String(q.area) : '',
    metro: metros.join(','),
    metros,
    metroArc,
    query: q.query ? String(q.query) : '',
    listingId: q.listingId ? String(q.listingId) : '',
    pets: bool(q.pets),
    children: bool(q.children),
    roomOnly,
    withPhotos: bool(q.withPhotos),
    maxAgeDays,
    sources,
    offset,
    limit,
    cursor: q.cursor ? String(q.cursor) : '',
    includeStats: bool(q.includeStats) === true,
    statsOnly: bool(q.statsOnly) === true,
    mapOnly: bool(q.mapOnly) === true,
  };
}

function resolveCountries(query) {
  const requested = String(query.countries || COUNTRY_CODES.join(','))
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((country) => COUNTRY_CODES.includes(country));

  return requested.length ? requested : COUNTRY_CODES;
}

function canonicalizeCityFilter(filters, codes) {
  if (!filters.city) return;
  const country = codes.length === 1 ? codes[0] : undefined;
  filters.city = canonicalCity(filters.city, country) || filters.city;
}

async function tryPostgresSearch({filters, codes, force}) {
  if (force) {
    void refreshAll('manual').catch((err) => {
      console.warn('[postgres-search] background refresh failed:', err?.message ?? err);
    });
  }

  let searchError = null;
  const searchMatches = filters.query
    ? await searchListingMatches(filters.query, {
        countries: codes,
        sources: filters.sources,
      }).catch((err) => {
        searchError = err?.message ?? String(err);
        console.warn(`[elasticsearch] postgres search fallback: ${searchError}`);
        return null;
      })
    : null;

  let fxRates = null;
  try {
    fxRates = (await getRates()).rates;
  } catch {}

  if (filters.mapOnly) {
    const result = await searchPostgresMapPoints({
      filters,
      countries: codes,
      rates: fxRates,
      searchMatches,
    });
    return {
      count: result.count,
      degradedCountries: [],
      sourceCounts: {},
      sourceErrors: searchError
        ? [{source: 'elasticsearch', error: searchError}]
        : [],
      warming: false,
      filters,
      searchEngine: filters.query
        ? (searchMatches ? 'elasticsearch+postgres' : 'postgres-fallback')
        : 'postgres',
      searchIndexedMatches: searchMatches?.total ?? null,
      searchTruncated: searchMatches?.truncated ?? false,
      queryMs: result.queryMs,
      mapPoints: result.points,
      mapPointsTruncated: result.truncated,
      mapPointPages: result.pages,
      mapPointLimit: result.maxPoints,
      listings: [],
      nextCursor: null,
    };
  }

  const result = await searchPostgresListings({
    filters,
    countries: codes,
    rates: fxRates,
    searchMatches,
  });

  let listings = result.listings;
  let marketComparisonMs = 0;
  if (listings.length && fxRates) {
    const marketStartedAt = performance.now();
    try {
      listings = await attachMarketComparisons(listings, fxRates);
    } catch (err) {
      console.warn('[market-comparison] enrichment failed:', err?.message ?? err);
    } finally {
      marketComparisonMs = Math.round((performance.now() - marketStartedAt) * 10) / 10;
    }
  }

  // Keep the list endpoint cheap. Nearby transport is intentionally hydrated
  // only by the single-listing response pipeline (preparePublicListing), where
  // at most one listing pays for the geo-catalog lookup. Running it here used
  // to make UZ page latency scale roughly linearly with the page size and could
  // exceed nginx/client timeouts before response headers were written.

  return {
    count: result.count,
    degradedCountries: [],
    sourceCounts: {},
    sourceErrors: searchError
      ? [{source: 'elasticsearch', error: searchError}]
      : [],
    warming: false,
    filters,
    searchEngine: filters.query
      ? (searchMatches ? 'elasticsearch+postgres' : 'postgres-fallback')
      : 'postgres',
    searchIndexedMatches: searchMatches?.total ?? null,
    searchTruncated: searchMatches?.truncated ?? false,
    queryMs: result.queryMs,
    countMs: result.countMs ?? null,
    pageMs: result.pageMs ?? null,
    marketComparisonMs,
    searchPath: result.searchPath ?? null,
    nextCursor: result.nextCursor,
    listings,
    ...(result.statistics ? {statistics: result.statistics} : {}),
  };
}

export function installListingRoutes(app) {
  app.get('/api/listings', async (req, res) => {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';

    if (force && !checkRate(req, res, 'reloadAll', 8000)) {
      return;
    }

    const filters = parseListingFilters(req.query);
    const codes = resolveCountries(req.query);
    canonicalizeCityFilter(filters, codes);
    attachResolvedSearchGeometry(filters, codes);

    let custom = {warming: false, sourceErrors: []};
    if (filters.customSources.length) {
      try {
        custom = await prepareCustomSources({
          urls: filters.customSources,
          countries: codes,
        });
        filters.customSources = custom.urls;
        if (filters.sources.length && !filters.sources.includes('custom')) {
          filters.sources.push('custom');
        }
      } catch (err) {
        const error = err?.message ?? String(err);
        console.warn('[custom-source] queue preparation failed:', error);
        custom = {
          warming: false,
          sourceErrors: [{source: 'custom', error}],
        };
      }
    }

    try {
      const response = await tryPostgresSearch({filters, codes, force});
      response.warming = Boolean(response.warming || custom.warming);
      response.sourceErrors = [
        ...(response.sourceErrors || []),
        ...(custom.sourceErrors || []),
      ];
      return res.json(response);
    } catch (err) {
      const error = err?.message ?? String(err);
      console.error('[postgres-search] public search unavailable:', error);
      return res.status(503).json({
        error: 'Listing search temporarily unavailable',
        degraded: true,
        sourceErrors: [
          {source: 'postgres', error},
          ...(custom.sourceErrors || []),
        ],
        searchEngine: 'postgres',
        filters,
        count: 0,
        listings: [],
        ...(filters.mapOnly ? {mapPoints: []} : {}),
      });
    }
  });
}
