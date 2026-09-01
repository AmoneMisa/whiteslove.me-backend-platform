import test from 'node:test';
import assert from 'node:assert/strict';

import {closeDb, pool, upsertListings} from '../src/db.js';
import {assertDatabaseReady} from '../src/db-ready.js';
import {searchPostgresListings} from '../src/postgres-search.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';

test('PostgreSQL fast path filters mixed-currency listings and paginates with a cursor', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  await pool.query(`DELETE FROM listings WHERE source = 'pg-search-test'`);
  await pool.query(`DELETE FROM listings WHERE source = 'olx' AND country = 'ZZ'`);

  const now = Date.now();
  const listing = (id, price, currency, city, airConditioner, minutesAgo) => ({
    id,
    source: 'pg-search-test',
    country: 'UA',
    title: `Test ${id}`,
    description: 'integration test listing',
    propertyType: 'flat',
    dealType: 'longRent',
    byAgency: false,
    price,
    currency,
    rooms: 2,
    areaSqm: 50,
    city,
    district: city === 'Odesa' ? 'Prymorskyi' : null,
    createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
    commercial: false,
    airConditioner,
    parking: true,
  });

  await upsertListings([
    listing('usd-250', 250, 'USD', 'Odesa', true, 1),
    listing('uah-10000', 10_000, 'UAH', 'Odesa', true, 2),
    listing('usd-500', 500, 'USD', 'Odesa', true, 3),
    listing('kyiv-200', 200, 'USD', 'Kyiv', true, 4),
    listing('no-ac', 200, 'USD', 'Odesa', false, 5),
    {...listing('room-share', 210, 'USD', 'Odesa', true, 6), roomOnly: true},
  ]);

  const filters = {
    propertyType: 'any',
    dealType: 'longRent',
    agency: 'any',
    audience: 'any',
    priceMax: 300,
    priceTolerance: 0,
    priceCurrency: 'USD',
    city: 'Odesa',
    airConditioner: true,
    sources: [],
    sort: 'newest',
    limit: 1,
    offset: 0,
    includeStats: true,
  };

  const first = await searchPostgresListings({
    filters,
    countries: ['UA'],
    rates: {USD: 1, UAH: 40},
  });

  assert.equal(first.count, 2);
  assert.equal(first.listings.length, 1);
  assert.equal(first.listings[0].id, 'usd-250');
  assert.ok(first.nextCursor);
  assert.equal(first.statistics.total, 2);
  assert.equal(first.statistics.dealTypes[0]?.key, 'longRent');
  assert.equal(first.statistics.dealTypes[0]?.count, 2);
  assert.equal(first.statistics.geographies.city[0]?.label, 'Odesa');
  assert.ok(!first.listings.some((item) => item.id === 'room-share'));

  const roomOnly = await searchPostgresListings({
    filters: {...filters, roomOnly: true, priceMax: null, limit: 20, cursor: '', offset: 0},
    countries: ['UA'],
    rates: {USD: 1, UAH: 40},
  });
  assert.equal(roomOnly.count, 1);
  assert.equal(roomOnly.listings[0]?.id, 'room-share');

  await upsertListings([
    listing('kyiv-ru', 600, 'USD', 'Киев', true, 6),
    listing('kyiv-uk', 800, 'USD', 'Київ', true, 7),
  ]);
  const kyiv = await searchPostgresListings({filters: {...filters, city: 'Kyiv', priceMax: null, limit: 20, includeStats: true}, countries: ['UA'], rates: {USD: 1, UAH: 40}});
  assert.equal(kyiv.count, 3);
  assert.equal(kyiv.statistics.geographies.city.length, 1);
  assert.equal(kyiv.statistics.geographies.city[0]?.label, 'Kyiv');
  assert.equal(kyiv.statistics.geographies.city[0]?.medianUsd, 600);
  const storedKyiv = await pool.query("SELECT city, data->>'city' AS data_city, data->>'sourceCity' AS source_city FROM listings WHERE source='pg-search-test' AND source_id='kyiv-ru'");
  assert.deepEqual(storedKyiv.rows[0], {city: 'Kyiv', data_city: 'Kyiv', source_city: 'Киев'});

  const second = await searchPostgresListings({
    filters: {...filters, cursor: first.nextCursor, offset: 999},
    countries: ['UA'],
    rates: {USD: 1, UAH: 40},
  });

  assert.equal(second.count, 2);
  assert.equal(second.listings.length, 1);
  assert.equal(second.listings[0].id, 'uah-10000');

  const noEsMatches = await searchPostgresListings({
    filters: {...filters, query: 'Test', cursor: '', offset: 0},
    countries: ['UA'],
    rates: {USD: 1, UAH: 40},
    searchMatches: {rank: new Map(), scores: new Map(), total: 0, truncated: false},
  });
  assert.equal(noEsMatches.count, 0);
  assert.equal(noEsMatches.listings.length, 0);

  const duplicateDescription = [
    'Сдается квартира рядом с метро Новза.',
    'Одинаковое описание используется в повторно опубликованном объявлении,',
    'поэтому разные OLX id не должны превращаться в отдельные карточки.',
  ].join(' ');

  const olxListing = (id, minutesAgo, photos, title = 'Квартира метро Новза') => ({
    id,
    source: 'olx',
    country: 'ZZ',
    title,
    description: duplicateDescription,
    propertyType: 'flat',
    dealType: 'longRent',
    byAgency: false,
    price: 450,
    currency: 'USD',
    rooms: 2,
    areaSqm: 55,
    city: 'Tashkent',
    district: 'Chilanzar',
    metro: 'Novza',
    createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
    commercial: false,
    photos,
  });

  const samePhotoA = 'https://apollo.olxcdn.example/v1/files/shared-a/image;s=800x600';
  const samePhotoB = 'https://apollo.olxcdn.example/v1/files/shared-b/image;s=800x600';

  await upsertListings([
    olxListing('dup-new', 1, [
      {link: `${samePhotoA}?token=new`},
      {link: `${samePhotoB}?token=new`},
    ]),
    olxListing('dup-old', 30, [
      {link: samePhotoA.replace('800x600', '1200x900')},
      {link: samePhotoB.replace('800x600', '1200x900')},
    ]),
    olxListing('distinct', 2, [
      {link: 'https://apollo.olxcdn.example/v1/files/other-a/image;s=800x600'},
      {link: 'https://apollo.olxcdn.example/v1/files/other-b/image;s=800x600'},
    ], 'Другая квартира метро Новза'),
  ]);

  const olxFilters = {
    propertyType: 'any',
    dealType: 'longRent',
    agency: 'any',
    audience: 'any',
    city: 'Tashkent',
    sources: ['olx'],
    sort: 'newest',
    limit: 20,
    offset: 0,
  };

  const deduped = await searchPostgresListings({
    filters: olxFilters,
    countries: ['ZZ'],
    rates: {USD: 1},
  });

  assert.equal(deduped.count, 2);
  assert.deepEqual(
    deduped.listings.map((item) => item.id).sort(),
    ['distinct', 'dup-new'],
  );

  const exactOldShareLink = await searchPostgresListings({
    filters: {...olxFilters, listingId: 'dup-old'},
    countries: ['ZZ'],
    rates: {USD: 1},
  });

  assert.equal(exactOldShareLink.count, 1);
  assert.equal(exactOldShareLink.listings[0]?.id, 'dup-old');

  await pool.query(`DELETE FROM listings WHERE source = 'pg-search-test'`);
  await pool.query(`DELETE FROM listings WHERE source = 'olx' AND country = 'ZZ'`);
  await closeDb();
});
