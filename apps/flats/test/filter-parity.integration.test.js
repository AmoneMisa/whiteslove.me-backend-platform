import test from 'node:test';
import assert from 'node:assert/strict';

import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';
import {closeDb, pool, upsertListings} from '../src/infrastructure/database/listingRepository.js';
import {applyListingFilters} from '../src/legacy-listing-filter.js';
import {searchPostgresListings} from '../src/postgres-search.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';
const SOURCE = 'filter-parity-test';
const COUNTRY = 'XY';

function listing(id, overrides = {}) {
  return {
    id,
    source: SOURCE,
    country: COUNTRY,
    title: `Parity ${id}`,
    description: 'Filter parity integration listing',
    propertyType: 'flat',
    dealType: 'longRent',
    byAgency: false,
    price: 300,
    currency: 'USD',
    rooms: 2,
    bedrooms: 1,
    areaSqm: 50,
    city: 'Parity City',
    district: 'Central District',
    metro: 'Main Station',
    createdAt: new Date().toISOString(),
    commercial: false,
    ...overrides,
  };
}

function baseFilters(overrides = {}) {
  return {
    propertyType: 'any',
    dealType: 'any',
    agency: 'any',
    audience: 'any',
    sources: [],
    city: '',
    district: '',
    metro: '',
    limit: 60,
    offset: 0,
    ...overrides,
  };
}

async function postgresIds(filters, rates = {USD: 1, UAH: 40}) {
  const result = await searchPostgresListings({
    filters,
    countries: [COUNTRY],
    rates,
  });
  return result.listings.map((item) => item.id).sort();
}

function legacyIds(listings, filters, rates = {USD: 1, UAH: 40}) {
  return applyListingFilters(listings, filters, rates)
    .map((item) => item.id)
    .sort();
}

test('in-memory and PostgreSQL search share core filter semantics', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  await pool.query('DELETE FROM listings WHERE source = $1 AND country = $2', [SOURCE, COUNTRY]);

  const listings = [
    listing('long-owner-usd', {
      airConditioner: true,
      petsAllowed: true,
      childrenAllowed: true,
    }),
    listing('short-owner-uah', {
      dealType: 'shortRent',
      price: 10_000,
      currency: 'UAH',
      airConditioner: true,
      petsAllowed: true,
      childrenAllowed: true,
    }),
    listing('long-agency', {
      byAgency: true,
      price: 450,
      airConditioner: true,
    }),
    listing('no-ac', {
      price: 250,
      airConditioner: false,
    }),
    listing('other-city', {
      city: 'Parity City Center',
      district: 'Outer District',
      metro: 'Other Station',
    }),
    listing('commercial', {
      price: 100,
      commercial: true,
    }),
  ];

  await upsertListings(listings);

  try {
    const cases = [
      baseFilters({dealType: 'shortRent'}),
      baseFilters({dealType: 'longRent', agency: 'owner'}),
      baseFilters({priceMax: 320, priceCurrency: 'USD'}),
      baseFilters({airConditioner: true}),
      baseFilters({pets: true, children: true}),
      baseFilters({roomsMin: 2, roomsMax: 2, areaMin: 45, areaMax: 55}),
      baseFilters({city: 'Parity City'}),
      baseFilters({district: 'central district'}),
      baseFilters({metro: 'main station'}),
    ];

    for (const filters of cases) {
      assert.deepEqual(
        await postgresIds(filters),
        legacyIds(listings, filters),
        `filter parity failed for ${JSON.stringify(filters)}`,
      );
    }

    const exactCity = baseFilters({city: 'Parity City'});
    const expectedCityIds = listings
      .filter((item) => item.city === 'Parity City' && !item.commercial)
      .map((item) => item.id)
      .sort();
    assert.deepEqual(legacyIds(listings, exactCity), expectedCityIds);
    assert.deepEqual(await postgresIds(exactCity), expectedCityIds);
  } finally {
    await pool.query('DELETE FROM listings WHERE source = $1 AND country = $2', [SOURCE, COUNTRY]);
    await closeDb();
  }
});
