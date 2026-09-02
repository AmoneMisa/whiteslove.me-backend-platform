import assert from 'node:assert/strict';
import test from 'node:test';

import {closeDb, pool, upsertListings} from '../src/infrastructure/database/listingRepository.js';
import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';
import {searchPostgresMapPoints} from '../src/routes/map-feed.js';
import {searchPostgresListings} from '../src/support/postgres-search.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';

function columnKey(row) {
  return `${row.table_schema}.${row.table_name}.${row.column_name}`;
}

test('performance hardening schema and search paths work together', {skip: !enabled}, async () => {
  await assertDatabaseReady();

  const columns = await pool.query(`
    SELECT table_schema, table_name, column_name, data_type, character_maximum_length
    FROM information_schema.columns
    WHERE (table_schema = 'public' AND table_name IN (
      'crawl_tasks',
      'crawl_task_runs',
      'places',
      'learned_geo',
      'listing_location_terms',
      'listing_nearby_places',
      'listing_property_clusters'
    ))
    OR (table_schema = 'subscriptions' AND table_name = 'mobile_subscriptions');
  `);
  const byName = new Map(columns.rows.map((row) => [columnKey(row), row]));

  const varchar = (key, length) => {
    const row = byName.get(key);
    assert.ok(row, `missing column ${key}`);
    assert.equal(row.data_type, 'character varying', `${key} should be varchar`);
    assert.equal(Number(row.character_maximum_length), length, `${key} length`);
  };

  varchar('public.crawl_tasks.crawl_generation', 128);
  varchar('public.crawl_tasks.type', 64);
  varchar('public.crawl_tasks.country', 8);
  varchar('public.crawl_tasks.status', 16);
  varchar('public.crawl_tasks.locked_by', 200);
  varchar('public.crawl_task_runs.crawl_generation', 128);
  varchar('public.places.city', 160);
  varchar('public.places.name', 255);
  varchar('public.places.name_ru', 255);
  varchar('public.listing_location_terms.term_type', 64);
  varchar('public.listing_location_terms.normalized_name', 512);
  varchar('public.listing_nearby_places.kind', 64);
  varchar('public.learned_geo.country', 8);
  varchar('public.learned_geo.entity_type', 64);
  varchar('public.learned_geo.provider', 32);
  varchar('subscriptions.mobile_subscriptions.name', 120);
  assert.equal(byName.get('public.crawl_tasks.lock_token')?.data_type, 'uuid');
  assert.equal(byName.get('public.listing_property_clusters.cluster_id')?.data_type, 'text');

  await pool.query(`DELETE FROM listing_property_clusters WHERE source = 'perf-cluster-test'`);
  await pool.query(`DELETE FROM listings WHERE source = 'perf-hardening-test'`);

  const createdAt = new Date().toISOString();
  const common = {
    source: 'perf-hardening-test',
    country: 'ZZ',
    description: 'A test listing that exercises typed filters, normalized relations and map radius search.',
    propertyType: 'flat',
    dealType: 'longRent',
    byAgency: false,
    price: 600,
    currency: 'USD',
    rooms: 2,
    bedrooms: 1,
    floor: 4,
    totalFloors: 10,
    buildingYear: 2015,
    commissionPercent: 0,
    metroDistanceM: 450,
    areaSqm: 52,
    city: 'Perf City',
    district: 'Perf District',
    microdistrict: 'Perf Microdistrict',
    localAreas: ['Perf Quarter'],
    nearbyPlaces: [{kind: 'school', distanceM: 300}],
    propertyClusterId: 'property:perf-search-shared',
    commercial: false,
  };

  await upsertListings([
    {
      ...common,
      id: 'typed-search-1',
      title: 'Performance hardening integration flat',
      lat: 50,
      lng: 30,
      createdAt,
    },
    {
      ...common,
      id: 'typed-search-old',
      title: 'Older duplicate performance flat',
      lat: 50.0001,
      lng: 30.0001,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ]);

  const stored = await pool.query(`
    SELECT id, bedrooms, floor_number, total_floors, building_year,
           commission_percent, metro_distance_m, lat, lng
    FROM listings
    WHERE source = 'perf-hardening-test' AND source_id = 'typed-search-1';
  `);
  assert.equal(stored.rowCount, 1);
  assert.deepEqual(
    {
      bedrooms: Number(stored.rows[0].bedrooms),
      floor: Number(stored.rows[0].floor_number),
      totalFloors: Number(stored.rows[0].total_floors),
      buildingYear: Number(stored.rows[0].building_year),
      commissionPercent: Number(stored.rows[0].commission_percent),
      metroDistanceM: Number(stored.rows[0].metro_distance_m),
      lat: Number(stored.rows[0].lat),
      lng: Number(stored.rows[0].lng),
    },
    {
      bedrooms: 1,
      floor: 4,
      totalFloors: 10,
      buildingYear: 2015,
      commissionPercent: 0,
      metroDistanceM: 450,
      lat: 50,
      lng: 30,
    },
  );

  const listingId = stored.rows[0].id;
  const termsBefore = await pool.query(`
    SELECT term_type, normalized_name, ctid::text AS ctid
    FROM listing_location_terms
    WHERE listing_id = $1
    ORDER BY term_type, normalized_name;
  `, [listingId]);
  assert.ok(termsBefore.rows.some((row) => row.term_type === 'microdistrict' && row.normalized_name === 'perf microdistrict'));
  assert.ok(termsBefore.rows.some((row) => row.term_type === 'local_area' && row.normalized_name === 'perf quarter'));

  const nearby = await pool.query(`
    SELECT kind, distance_m
    FROM listing_nearby_places
    WHERE listing_id = $1;
  `, [listingId]);
  assert.deepEqual(nearby.rows.map((row) => ({kind: row.kind, distanceM: Number(row.distance_m)})), [
    {kind: 'school', distanceM: 300},
  ]);

  // Updating unrelated JSONB must not delete/reinsert normalized relation rows.
  await pool.query(`
    UPDATE listings
    SET data = jsonb_set(data, '{performanceTestMarker}', 'true'::jsonb, true)
    WHERE id = $1;
  `, [listingId]);
  const termsAfter = await pool.query(`
    SELECT term_type, normalized_name, ctid::text AS ctid
    FROM listing_location_terms
    WHERE listing_id = $1
    ORDER BY term_type, normalized_name;
  `, [listingId]);
  assert.deepEqual(termsAfter.rows, termsBefore.rows);

  // Materialized helper relations must never turn an otherwise valid listing
  // update into a VARCHAR overflow. Upstream JSON remains lossless; only the
  // bounded acceleration rows are capped to their schema contract.
  const longType = 't'.repeat(80);
  const longName = 'n'.repeat(600);
  const longLocalArea = 'a'.repeat(600);
  const longKind = 'k'.repeat(80);
  await pool.query(`
    UPDATE listings
    SET data = data || jsonb_build_object(
      'locationEntities', jsonb_build_array(jsonb_build_object('type', $2::text, 'name', $3::text)),
      'localAreas', COALESCE(data->'localAreas', '[]'::jsonb) || jsonb_build_array($4::text),
      'nearbyPlaces', COALESCE(data->'nearbyPlaces', '[]'::jsonb)
        || jsonb_build_array(jsonb_build_object('kind', $5::text, 'distanceM', 123))
    )
    WHERE id = $1;
  `, [listingId, longType, longName, longLocalArea, longKind]);

  const boundedTerms = await pool.query(`
    SELECT term_type, normalized_name
    FROM listing_location_terms
    WHERE listing_id = $1;
  `, [listingId]);
  assert.ok(boundedTerms.rows.some((row) => row.term_type === longType.slice(0, 64) && row.normalized_name === longName.slice(0, 512)));
  assert.ok(boundedTerms.rows.some((row) => row.term_type === 'local_area' && row.normalized_name === longLocalArea.slice(0, 512)));
  assert.ok(boundedTerms.rows.every((row) => row.term_type.length <= 64 && row.normalized_name.length <= 512));

  const boundedNearby = await pool.query(`
    SELECT kind
    FROM listing_nearby_places
    WHERE listing_id = $1;
  `, [listingId]);
  assert.ok(boundedNearby.rows.some((row) => row.kind === longKind.slice(0, 64)));
  assert.ok(boundedNearby.rows.every((row) => row.kind == null || row.kind.length <= 64));

  const filters = {
    propertyType: 'any',
    dealType: 'longRent',
    agency: 'any',
    audience: 'any',
    city: 'Perf City',
    bedroomsMin: 1,
    bedroomsMax: 1,
    floorMin: 4,
    floorMax: 4,
    metroMaxM: 500,
    nearbyKind: 'school',
    nearbyMaxM: 400,
    centerLat: 50,
    centerLng: 30,
    radiusM: 1000,
    sources: [],
    sort: 'newest',
    limit: 20,
    offset: 0,
  };

  const search = await searchPostgresListings({
    filters,
    countries: ['ZZ'],
    rates: {USD: 1},
  });
  assert.equal(search.count, 1, 'property-cluster dedupe should preserve one representative');
  assert.equal(search.listings[0]?.id, 'typed-search-1');

  const map = await searchPostgresMapPoints({
    filters,
    countries: ['ZZ'],
    rates: {USD: 1},
  });
  assert.equal(map.count, 1);
  assert.equal(map.pages, 1);
  assert.equal(map.truncated, false);
  assert.deepEqual(map.points.map((point) => point.id), ['typed-search-1']);

  // Two overlapping cluster merges issued concurrently must converge on one
  // cluster rather than leaving split membership across service replicas.
  const payloadA = JSON.stringify([
    {source: 'perf-cluster-test', country: 'ZZ', source_id: 'a'},
    {source: 'perf-cluster-test', country: 'ZZ', source_id: 'b'},
  ]);
  const payloadB = JSON.stringify([
    {source: 'perf-cluster-test', country: 'ZZ', source_id: 'b'},
    {source: 'perf-cluster-test', country: 'ZZ', source_id: 'c'},
  ]);
  await Promise.all([
    pool.query('SELECT merge_listing_property_cluster($1::jsonb, $2::text)', [payloadA, 'property:perf-a']),
    pool.query('SELECT merge_listing_property_cluster($1::jsonb, $2::text)', [payloadB, 'property:perf-b']),
  ]);
  const clusters = await pool.query(`
    SELECT COUNT(*)::int AS members, COUNT(DISTINCT cluster_id)::int AS clusters
    FROM listing_property_clusters
    WHERE source = 'perf-cluster-test' AND country = 'ZZ';
  `);
  assert.equal(clusters.rows[0]?.members, 3);
  assert.equal(clusters.rows[0]?.clusters, 1);

  await pool.query(`DELETE FROM listing_property_clusters WHERE source = 'perf-cluster-test'`);
  await pool.query(`DELETE FROM listings WHERE source = 'perf-hardening-test'`);
  await closeDb();
});
