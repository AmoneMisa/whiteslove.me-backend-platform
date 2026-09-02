import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

test('hot listing filters use typed columns and normalized relations', async () => {
  const search = await source('../src/infrastructure/search/postgres-search-core.js');

  for (const column of [
    'l.bedrooms',
    'l.floor_number',
    'l.total_floors',
    'l.building_year',
    'l.commission_percent',
    'l.metro_distance_m',
  ]) {
    assert.match(search, new RegExp(column.replace('.', '\\.')));
  }
  assert.match(search, /FROM listing_location_terms term/u);
  assert.match(search, /FROM listing_nearby_places place/u);
  assert.match(search, /l\.lat BETWEEN/u);
  assert.match(search, /l\.lng BETWEEN/u);
  assert.match(search, /const EARTH_RADIUS_M = 6_371_000/u);
  assert.match(search, /const angularRadius = radiusM \/ EARTH_RADIUS_M/u);
  assert.match(search, /Math\.asin\(ratio\)/u);
  assert.match(search, /\$\{EARTH_RADIUS_M\} \* ACOS/u);
  assert.doesNotMatch(search, /radiusM \/ 111_320/u);
});

test('mobile subscription scans claim durable delivery before FCM send', async () => {
  const mobile = await source('../src/mobile-subscriptions.js');

  assert.match(mobile, /pg_try_advisory_lock/u);
  assert.match(mobile, /async function claimDelivery/u);
  assert.match(mobile, /ON CONFLICT \(device_id, kind, item_key\) DO UPDATE/u);
  assert.match(mobile, /status = 'sending'/u);
  assert.match(mobile, /lock_token = \$3::uuid/u);
  assert.match(mobile, /deliveryId:/u);
  assert.match(mobile, /UNNEST\(\$2::text\[\]\)/u);
  assert.doesNotMatch(mobile, /async function seen\(/u);
  assert.doesNotMatch(mobile, /async function delivered\(/u);
});

test('photo anti-fake uses indexed bands and one atomic cluster merge call', async () => {
  const antiFake = await source('../src/photo-antifake.js');

  assert.match(antiFake, /SUBSTRING\(perceptual_hash FROM 1 FOR 2\)/u);
  assert.match(antiFake, /SUBSTRING\(perceptual_hash FROM 15 FOR 2\)/u);
  assert.match(antiFake, /merge_listing_property_cluster\(\$1::jsonb, \$2::text\)/u);
  assert.doesNotMatch(antiFake, /PERCEPTUAL_CANDIDATE_LIMIT/u);
  assert.doesNotMatch(antiFake, /for \(const member of unique\)[\s\S]*INSERT INTO listing_property_clusters/u);
});

test('crawl queue batches inserts and rate-limits expired lease recovery', async () => {
  const queue = await source('../src/infrastructure/queue/pgQueue.js');

  assert.match(queue, /jsonb_to_recordset\(\$1::jsonb\)/u);
  assert.match(queue, /ENQUEUE_BATCH_SIZE/u);
  assert.match(queue, /maybeRecoverExpiredTasks/u);
  assert.match(queue, /pg_try_advisory_xact_lock/u);
  assert.match(queue, /RECOVERY_INTERVAL_MS/u);
  assert.doesNotMatch(queue, /async function insertTask/u);
  assert.doesNotMatch(queue, /for \(const task of tasks \|\| \[\]\)[\s\S]*await insertTask/u);
});

test('performance migrations own materialization, relations, delivery leases and atomic clustering', async () => {
  const hot = await source('../migrations/024_hot_filter_columns.sql');
  const relations = await source('../migrations/025_search_relations.sql');
  const spatial = await source('../migrations/026_spatial_prefilter.sql');
  const delivery = await source('../migrations/027_mobile_delivery_outbox.sql');
  const bands = await source('../migrations/028_perceptual_hash_bands.sql');
  const clusters = await source('../migrations/029_atomic_property_cluster_merge.sql');
  const feed = await source('../migrations/030_public_feed_member_upsert.sql');
  const bounded = await source('../migrations/032_bounded_text_types.sql');

  assert.match(hot, /GENERATED ALWAYS AS/u);
  assert.match(hot, /ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION/u);
  assert.match(hot, /ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION/u);
  assert.doesNotMatch(hot, /CREATE INDEX/u, '024 must release ALTER TABLE lock before index builds');
  assert.match(relations, /term_type VARCHAR\(64\)/u);
  assert.match(relations, /normalized_name VARCHAR\(512\)/u);
  assert.match(relations, /kind VARCHAR\(64\)/u);
  assert.match(relations, /LEFT\(LOWER\(BTRIM\(entity->>'type'\)\), 64\)/u);
  assert.match(relations, /LEFT\(LOWER\(BTRIM\(entity->>'name'\)\), 512\)/u);
  assert.match(relations, /CREATE TRIGGER listings_insert_search_relations/u);
  assert.match(relations, /CREATE TRIGGER listings_update_search_relations/u);
  assert.match(relations, /WHEN \(/u);
  assert.match(spatial, /listings_active_country_city_metro_distance_idx/u);
  assert.match(spatial, /listings_active_country_geo_idx/u);
  assert.match(delivery, /mobile_deliveries_status_check/u);
  assert.match(delivery, /locked_until/u);
  assert.match(bands, /listing_photo_hashes_phash_band_8_idx/u);
  assert.match(clusters, /CREATE OR REPLACE FUNCTION merge_listing_property_cluster/u);
  assert.match(clusters, /pg_advisory_xact_lock/u);
  assert.match(clusters, /property-cluster-merge-global/u);
  assert.match(clusters, /jsonb_to_recordset\(p_members\)/u);
  assert.match(feed, /ON CONFLICT \(listing_id\) DO UPDATE/u);
  assert.doesNotMatch(feed, /DELETE FROM listing_public_feed_members[\s\S]*INSERT INTO listing_public_feed_members/u);
  assert.match(bounded, /ALTER COLUMN lock_token TYPE UUID/u);
  assert.match(bounded, /ALTER COLUMN crawl_generation TYPE VARCHAR\(128\)/u);
  assert.match(bounded, /ALTER COLUMN name TYPE VARCHAR\(120\)/u);
  assert.match(bounded, /Do NOT alter trigger\/generated-column-bound hot columns here/u);
  assert.doesNotMatch(bounded, /ALTER COLUMN cluster_id TYPE VARCHAR/u);
});

test('places data reuses the main backend pool instead of opening an extra pool', async () => {
  const places = await source('../src/infrastructure/database/placesRepository.js');
  assert.match(places, /import \{pool\} from '\.\.\/\.\.\/db\.js'/u);
  assert.doesNotMatch(places, /new Pool\(/u);
  assert.doesNotMatch(places, /PLACES_DB_POOL_MAX/u);
});
