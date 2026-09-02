import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseListingFilters} from '../src/routes/listing-routes.js';
import {applyListingFilters} from '../src/legacy/legacy-listing-filter.js';

const appSource = readFileSync(
  new URL('../src/app.js', import.meta.url),
  'utf8',
);
const serverSource = readFileSync(
  new URL('../src/server.js', import.meta.url),
  'utf8',
);
const listingRoutesSource = readFileSync(
  new URL('../src/routes/listing-routes.js', import.meta.url),
  'utf8',
);
const postgresSearchSource = readFileSync(
  new URL('../src/infrastructure/search/postgres-search-core.js', import.meta.url),
  'utf8',
);

test('application composes listing routes while server owns no search orchestration', () => {
  assert.match(appSource, /installListingRoutes\(app\)/);
  assert.doesNotMatch(serverSource, /app\.get\('\/api\/listings'/);
  assert.doesNotMatch(serverSource, /searchPostgresListings/);
  assert.doesNotMatch(serverSource, /getListings\(/);

  assert.match(listingRoutesSource, /app\.get\('\/api\/listings'/);
  assert.match(listingRoutesSource, /tryPostgresSearch/);
  assert.match(listingRoutesSource, /prepareCustomSources/);
  assert.doesNotMatch(listingRoutesSource, /legacySnapshotSearch/);
  assert.doesNotMatch(listingRoutesSource, /getListings\(/);
  assert.doesNotMatch(listingRoutesSource, /applyListingFilters/);
  assert.doesNotMatch(listingRoutesSource, /scrapers\/index/);
  assert.doesNotMatch(listingRoutesSource, /scrapers\/custom/);
  assert.doesNotMatch(listingRoutesSource, /from '\.\/normalize\.js'/);
});

test('all listing searches use PostgreSQL and expose explicit degraded failures', () => {
  assert.match(listingRoutesSource, /prepareCustomSources/);
  assert.match(listingRoutesSource, /tryPostgresSearch\(\{filters, codes, force\}\)/);
  assert.match(listingRoutesSource, /res\.status\(503\)\.json/);
  assert.match(listingRoutesSource, /Listing search temporarily unavailable/);
  assert.match(listingRoutesSource, /source: 'postgres'/);
  assert.doesNotMatch(listingRoutesSource, /legacy fallback/i);
});

test('persisted custom listings are scoped to explicitly requested source URLs', () => {
  assert.match(postgresSearchSource, /l\.data->>'customSourceUrl'/);
  assert.match(postgresSearchSource, /l\.source <> 'custom'/);
  assert.match(postgresSearchSource, /customSources\.length/);
});

test('listing filters preserve the existing public query contract', () => {
  const filters = parseListingFilters({
    propertyType: 'flat',
    dealType: 'longRent',
    agency: 'owner',
    audience: 'family',
    priceMin: '100',
    priceMax: '900',
    priceCurrency: 'usd',
    roomsMin: '2',
    city: 'Odesa',
    query: 'center',
    sources: 'OLX,telegram,unknown',
    customSources: 'https://example.com/a,https://example.com/a,ftp://bad',
    pets: 'true',
    children: '1',
    withPhotos: 'true',
    limit: '999',
    offset: '20',
    cursor: 'abc',
    includeStats: '1',
  });

  assert.equal(filters.propertyType, 'flat');
  assert.equal(filters.dealType, 'longRent');
  assert.equal(filters.agency, 'owner');
  assert.equal(filters.audience, 'family');
  assert.equal(filters.priceMin, 100);
  assert.equal(filters.priceMax, 900);
  assert.equal(filters.priceCurrency, 'USD');
  assert.equal(filters.roomsMin, 2);
  assert.equal(filters.city, 'Odesa');
  assert.equal(filters.query, 'center');
  assert.deepEqual(filters.sources, ['olx', 'telegram']);
  assert.deepEqual(filters.customSources, ['https://example.com/a']);
  assert.equal(filters.pets, true);
  assert.equal(filters.children, true);
  assert.equal(filters.withPhotos, true);
  assert.equal(filters.limit, 60);
  assert.equal(filters.offset, 20);
  assert.equal(filters.cursor, 'abc');
  assert.equal(filters.includeStats, true);
});

test('analytics reuse the filtered deduplicated PostgreSQL dataset', () => {
  assert.match(postgresSearchSource, /pool\.query\(statsSql, baseParams\)/);
  assert.match(postgresSearchSource, /else if \(filters\.includeStats\)/);
  assert.match(postgresSearchSource, /duplicatesRejected/);
  assert.match(postgresSearchSource, /suspectedFake/);
  assert.match(postgresSearchSource, /'microdistrict'/);
  assert.doesNotMatch(listingRoutesSource, /compute.*stat/i);
});

test('listing filters sanitize invalid numeric values and pagination bounds', () => {
  const filters = parseListingFilters({
    priceMin: 'not-a-number',
    priceMax: 'Infinity',
    roomsMin: '-Infinity',
    areaMin: '52.5',
    offset: '-25.9',
    limit: '-7',
  });

  assert.equal(filters.priceMin, null);
  assert.equal(filters.priceMax, null);
  assert.equal(filters.roomsMin, null);
  assert.equal(filters.areaMin, 52.5);
  assert.equal(filters.offset, 0);
  assert.equal(filters.limit, 1);

  const fractional = parseListingFilters({offset: '2.9', limit: '10.8'});
  assert.equal(fractional.offset, 2);
  assert.equal(fractional.limit, 10);
});

test('in-memory filter preserves the public shortRent semantics for non-HTTP consumers', () => {
  const listings = [
    {
      id: 'short',
      source: 'olx',
      dealType: 'shortRent',
      propertyType: 'flat',
      commercial: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'long',
      source: 'olx',
      dealType: 'longRent',
      propertyType: 'flat',
      commercial: false,
      createdAt: new Date().toISOString(),
    },
  ];

  const shortOnly = applyListingFilters(listings, {
    dealType: 'shortRent',
    propertyType: 'any',
    agency: 'any',
    audience: 'any',
    sources: [],
  });
  assert.deepEqual(shortOnly.map((listing) => listing.id), ['short']);

  const allDeals = applyListingFilters(listings, {
    dealType: 'any',
    propertyType: 'any',
    agency: 'any',
    audience: 'any',
    sources: [],
  });
  assert.deepEqual(allDeals.map((listing) => listing.id), ['short', 'long']);
});
