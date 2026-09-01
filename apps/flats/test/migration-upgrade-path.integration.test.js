import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import {listMigrationFiles} from '../src/migration-files.js';

const {Client} = pg;
const enabled = process.env.TEST_POSTGRES_SEARCH === '1';

function connectionConfig(database) {
  const url = String(process.env.TEST_POSTGRES_URL || '').trim();
  if (url) {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    return {connectionString: parsed.toString()};
  }
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5432,
    database,
    user: process.env.POSTGRES_USER || 'flatfinder',
    password: process.env.POSTGRES_PASSWORD,
  };
}

function migrationVersion(file) {
  return Number.parseInt(String(file).slice(0, 3), 10);
}

async function applyMigration(client, file) {
  const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applyMigrations(client, files) {
  for (const file of files) await applyMigration(client, file);
}

function columnKey(row) {
  return `${row.table_schema}.${row.table_name}.${row.column_name}`;
}

test('production-like schema upgrades from 023 with legacy rows intact', {skip: !enabled}, async () => {
  const suffix = `${process.pid}_${randomBytes(5).toString('hex')}`;
  const database = `flatfinder_upgrade_${suffix}`;
  const baseDatabase = process.env.POSTGRES_DB || 'flatfinder';
  const admin = new Client(connectionConfig(baseDatabase));
  let client;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    client = new Client(connectionConfig(database));
    await client.connect();

    const migrationFiles = await listMigrationFiles();
    const legacyFiles = migrationFiles.filter((file) => migrationVersion(file) <= 23);
    const hardeningFiles = migrationFiles.filter((file) => {
      const version = migrationVersion(file);
      return version >= 24 && version < 32;
    });
    const boundedFile = migrationFiles.find((file) => migrationVersion(file) === 32);
    assert.ok(boundedFile, 'migration 032 must exist');

    // Reproduce the actual upgrade shape: the production schema already owns
    // migrations through 023 and already contains rows when 024+ deploys.
    await applyMigrations(client, legacyFiles);

    await client.query(`
      INSERT INTO listings (
        source, country, source_id, title, description,
        property_type, deal_type, city, district, price, currency,
        rooms, area_sqm, by_agency, created_at, data
      ) VALUES (
        'olx', 'UZ', 'upgrade-listing-1', 'Legacy upgrade listing', 'upgrade fixture',
        'flat', 'longRent', 'Tashkent', 'Yunusabad', 700, 'USD',
        3, 78, FALSE, NOW(), $1::jsonb
      );
    `, [JSON.stringify({
      id: 'upgrade-listing-1',
      source: 'olx',
      country: 'UZ',
      title: 'Legacy upgrade listing',
      city: 'Tashkent',
      district: 'Yunusabad',
      propertyType: 'flat',
      dealType: 'longRent',
      bedrooms: 2,
      floor: 5,
      totalFloors: 12,
      buildingYear: 2019,
      commissionPercent: 0,
      metroDistanceM: 420,
      lat: 41.327,
      lng: 69.281,
      microdistrict: 'Yunusabad 19',
      localAreas: ['Yunusabad'],
      nearbyPlaces: [{kind: 'school', distanceM: 260}],
      commercial: false,
    })]);

    await client.query(`
      INSERT INTO crawl_tasks (
        task_key, crawl_generation, type, country, status,
        locked_by, lock_token, payload
      ) VALUES (
        'upgrade-task', 'legacy-generation', 'olx', 'UZ', 'running',
        'upgrade-worker', '123e4567-e89b-42d3-a456-426614174000', '{}'::jsonb
      );
      INSERT INTO crawl_task_runs (task_key, crawl_generation, status)
      VALUES ('upgrade-run', 'legacy-generation', 'done');
      INSERT INTO places (country, city, kind, name, name_ru, lat, lng, source, external_id)
      VALUES ('UZ', 'Tashkent', 'school', 'Legacy school', 'Старая школа', 41.32, 69.28, 'osm', 'upgrade-place');
      INSERT INTO learned_geo (
        lookup_key, country, region, city, district, street, house_number,
        building, entity_type, canonical_name, query_text, lat, lng,
        provider, provider_id, provider_type
      ) VALUES (
        'upgrade-geo', 'UZ', 'Tashkent Region', 'Tashkent', 'Yunusabad',
        'Amir Temur', '42', 'A', 'address', 'Amir Temur 42',
        'Amir Temur 42 Tashkent', 41.32, 69.28, 'nominatim', 'legacy-provider-id', 'house'
      );
      INSERT INTO subscriptions.mobile_devices (device_id, push_token)
      VALUES ('upgrade-device', 'upgrade-token');
      INSERT INTO subscriptions.mobile_subscriptions (device_id, preset_id, name, filters)
      VALUES ('upgrade-device', 'upgrade-preset', 'Legacy preset', '{}'::jsonb);
      INSERT INTO subscriptions.mobile_deliveries (device_id, kind, item_key)
      VALUES ('upgrade-device', 'flats', 'olx:UZ:upgrade-listing-1');
    `);

    await applyMigrations(client, hardeningFiles);

    const listing = await client.query(`
      SELECT bedrooms, floor_number, total_floors, building_year,
             commission_percent, metro_distance_m, lat, lng
      FROM listings
      WHERE source = 'olx' AND country = 'UZ' AND source_id = 'upgrade-listing-1';
    `);
    assert.equal(listing.rowCount, 1);
    assert.deepEqual({
      bedrooms: Number(listing.rows[0].bedrooms),
      floor: Number(listing.rows[0].floor_number),
      totalFloors: Number(listing.rows[0].total_floors),
      buildingYear: Number(listing.rows[0].building_year),
      commissionPercent: Number(listing.rows[0].commission_percent),
      metroDistanceM: Number(listing.rows[0].metro_distance_m),
      lat: Number(listing.rows[0].lat),
      lng: Number(listing.rows[0].lng),
    }, {
      bedrooms: 2,
      floor: 5,
      totalFloors: 12,
      buildingYear: 2019,
      commissionPercent: 0,
      metroDistanceM: 420,
      lat: 41.327,
      lng: 69.281,
    });

    const relations = await client.query(`
      SELECT term_type, normalized_name
      FROM listing_location_terms
      WHERE listing_id = (
        SELECT id FROM listings
        WHERE source = 'olx' AND country = 'UZ' AND source_id = 'upgrade-listing-1'
      )
      ORDER BY term_type, normalized_name;
    `);
    assert.ok(relations.rows.some((row) => row.term_type === 'microdistrict' && row.normalized_name === 'yunusabad 19'));
    assert.ok(relations.rows.some((row) => row.term_type === 'local_area' && row.normalized_name === 'yunusabad'));

    const nearby = await client.query(`
      SELECT kind, distance_m
      FROM listing_nearby_places
      WHERE listing_id = (
        SELECT id FROM listings
        WHERE source = 'olx' AND country = 'UZ' AND source_id = 'upgrade-listing-1'
      );
    `);
    assert.deepEqual(nearby.rows.map((row) => ({kind: row.kind, distanceM: Number(row.distance_m)})), [
      {kind: 'school', distanceM: 260},
    ]);

    const oldDelivery = await client.query(`
      SELECT status, sent_at, attempts, lock_token, locked_until
      FROM subscriptions.mobile_deliveries
      WHERE device_id = 'upgrade-device' AND item_key = 'olx:UZ:upgrade-listing-1';
    `);
    assert.equal(oldDelivery.rows[0]?.status, 'sent');
    assert.ok(oldDelivery.rows[0]?.sent_at);
    assert.equal(Number(oldDelivery.rows[0]?.attempts), 0);
    assert.equal(oldDelivery.rows[0]?.lock_token, null);
    assert.equal(oldDelivery.rows[0]?.locked_until, null);

    // Migration 032 must fail before ALTER TYPE if production contains an
    // oversized legacy value. A failed deployment must not silently truncate it.
    const oversizedName = 'x'.repeat(256);
    await client.query(`
      INSERT INTO places (country, city, kind, name, lat, lng, source, external_id)
      VALUES ('UZ', 'Tashkent', 'school', $1, 41.31, 69.27, 'osm', 'oversized-upgrade-place');
    `, [oversizedName]);
    await assert.rejects(
      applyMigration(client, boundedFile),
      /Cannot bound places\.name to varchar\(255\)/u,
    );
    const afterRejectedBound = await client.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'places' AND column_name = 'name';
    `);
    assert.equal(afterRejectedBound.rows[0]?.data_type, 'text');
    const preservedOversized = await client.query(`
      SELECT char_length(name)::int AS length
      FROM places WHERE external_id = 'oversized-upgrade-place';
    `);
    assert.equal(preservedOversized.rows[0]?.length, 256);

    await client.query(`DELETE FROM places WHERE external_id = 'oversized-upgrade-place'`);
    await applyMigration(client, boundedFile);

    const columns = await client.query(`
      SELECT table_schema, table_name, column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE (table_schema = 'public' AND table_name IN ('crawl_tasks', 'crawl_task_runs', 'places', 'learned_geo'))
         OR (table_schema = 'subscriptions' AND table_name = 'mobile_subscriptions');
    `);
    const byName = new Map(columns.rows.map((row) => [columnKey(row), row]));
    const varchar = (key, length) => {
      const row = byName.get(key);
      assert.ok(row, `missing upgraded column ${key}`);
      assert.equal(row.data_type, 'character varying', `${key} data type`);
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
    varchar('public.learned_geo.country', 8);
    varchar('public.learned_geo.region', 255);
    varchar('public.learned_geo.city', 255);
    varchar('public.learned_geo.district', 255);
    varchar('public.learned_geo.house_number', 64);
    varchar('public.learned_geo.building', 128);
    varchar('public.learned_geo.entity_type', 64);
    varchar('public.learned_geo.provider', 32);
    varchar('public.learned_geo.provider_type', 64);
    varchar('subscriptions.mobile_subscriptions.name', 120);
    assert.equal(byName.get('public.crawl_tasks.lock_token')?.data_type, 'uuid');

    const queue = await client.query(`
      SELECT crawl_generation, type, country, status, locked_by, lock_token::text AS lock_token
      FROM crawl_tasks WHERE task_key = 'upgrade-task';
    `);
    assert.deepEqual(queue.rows[0], {
      crawl_generation: 'legacy-generation',
      type: 'olx',
      country: 'UZ',
      status: 'running',
      locked_by: 'upgrade-worker',
      lock_token: '123e4567-e89b-42d3-a456-426614174000',
    });

    const indexes = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'listings_active_country_city_bedrooms_idx',
          'listings_active_country_geo_idx',
          'listing_location_terms_lookup_idx',
          'listing_nearby_places_kind_distance_idx'
        );
    `);
    assert.equal(indexes.rowCount, 4, 'hardening access paths should exist after an upgrade');
  } finally {
    if (client) await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
