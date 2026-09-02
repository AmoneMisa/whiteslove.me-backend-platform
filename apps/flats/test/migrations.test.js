import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import test from 'node:test';

const migrationsDir = new URL('../migrations/', import.meta.url);
const testsDir = new URL('./', import.meta.url);

async function migration(name) {
  return readFile(new URL(name, migrationsDir), 'utf8');
}

test('database migrations have unique ordered versions and non-empty SQL', async () => {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  assert.ok(files.length > 0, 'at least one SQL migration is required');

  const versions = new Set();
  for (const file of files) {
    const match = file.match(/^(\d{3})_[a-z0-9_]+\.sql$/);
    assert.ok(match, `invalid migration filename: ${file}`);
    assert.ok(!versions.has(match[1]), `duplicate migration version: ${match[1]}`);
    versions.add(match[1]);

    const sql = (await migration(file)).trim();
    assert.ok(sql.length > 0, `migration is empty: ${file}`);
  }
});

test('baseline migration creates listings before altering it', async () => {
  const sql = await migration('001_baseline_listings.sql');
  const createAt = sql.indexOf('CREATE TABLE IF NOT EXISTS listings');
  const alterAt = sql.indexOf('ALTER TABLE listings');

  assert.ok(createAt >= 0, 'baseline must create listings');
  assert.ok(alterAt > createAt, 'baseline must create listings before ALTER TABLE');
  assert.match(sql, /availability_checked_at/);
  assert.match(sql, /availability_status/);
  assert.match(sql, /listings_availability_due_idx/);
});

test('search indexes are versioned instead of created by API startup', async () => {
  const sql = await migration('003_search_indexes.sql');
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const search = await readFile(new URL('../src/support/postgres-search.js', import.meta.url), 'utf8');

  assert.match(sql, /listings_feed_newest_idx/);
  assert.match(sql, /listings_feed_price_idx/);
  assert.match(sql, /listings_active_data_gin_idx/);
  assert.doesNotMatch(server, /initPostgresSearchSchema/);
  assert.doesNotMatch(search, /initPostgresSearchSchema/);
  assert.doesNotMatch(search, /CREATE\s+INDEX/i);
});

test('queue dedup, places and listing semantics are versioned', async () => {
  const dedup = await migration('004_crawl_task_runs.sql');
  const places = await migration('005_places.sql');
  const semantics = await migration('006_listing_semantics.sql');

  assert.match(dedup, /CREATE TABLE IF NOT EXISTS crawl_task_runs/);
  assert.match(dedup, /crawl_task_runs_expiry_idx/);

  assert.match(places, /CREATE TABLE IF NOT EXISTS places/);
  assert.match(places, /places_identity_unique/);
  assert.match(places, /places_city_kind_idx/);
  assert.match(places, /places_lat_lng_idx/);

  assert.match(semantics, /CREATE OR REPLACE FUNCTION enforce_listing_agency_semantics/);
  assert.match(semantics, /CREATE TRIGGER listings_agency_semantics_trigger/);
  assert.match(semantics, /UPDATE listings/);
});

test('runtime entrypoints validate every migration file instead of creating schema', async () => {
  const entrypoints = [
    '../src/server.js',
    '../src/worker.js',
    '../src/reindex.js',
  ];
  const ready = await readFile(new URL('../src/infrastructure/database/schemaReady.js', import.meta.url), 'utf8');
  const policy = await readFile(new URL('../src/support/migration-files.js', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../src/migrate.js', import.meta.url), 'utf8');

  for (const file of entrypoints) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /assertDatabaseReady/, `${file} must validate migrations`);
    assert.doesNotMatch(source, /\binitDb\b/, `${file} must not bootstrap schema`);
  }

  assert.match(ready, /schema_migrations/);
  assert.match(ready, /listMigrationFiles/);
  assert.match(runner, /listMigrationFiles/);
  assert.match(policy, /MIGRATION_FILE_PATTERN/);
  assert.match(policy, /readdir\(migrationsDir\)/);
  assert.match(ready, /missingMigrations/);
  assert.doesNotMatch(ready, /REQUIRED_MIGRATIONS/);
  assert.doesNotMatch(ready, /CREATE\s+TABLE/i);
  assert.doesNotMatch(ready, /ALTER\s+TABLE/i);
  assert.doesNotMatch(ready, /CREATE\s+INDEX/i);
});

test('migrated runtime modules never mutate database schema', async () => {
  const files = [
    '../src/infrastructure/database/listingRepository.js',
    '../src/support/postgres-search.js',
    '../src/availability/availability.js',
    '../src/availability/availability-sweep.js',
    '../src/routes/availability-routes.js',
    '../src/infrastructure/queue/pgQueue.js',
    '../src/infrastructure/queue/queueTaskDedup.js',
    '../src/infrastructure/database/placesRepository.js',
    '../src/legacy/listing-semantics.js',
  ];

  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /ALTER\s+TABLE/i, `${file} must not ALTER TABLE`);
    assert.doesNotMatch(source, /CREATE\s+TABLE/i, `${file} must not CREATE TABLE`);
    assert.doesNotMatch(source, /CREATE\s+INDEX/i, `${file} must not CREATE INDEX`);
    assert.doesNotMatch(source, /CREATE\s+TRIGGER/i, `${file} must not CREATE TRIGGER`);
    assert.doesNotMatch(source, /CREATE\s+OR\s+REPLACE\s+FUNCTION/i, `${file} must not CREATE FUNCTION`);
    assert.doesNotMatch(source, /ensureAvailabilitySchema/);
    assert.doesNotMatch(source, /initAvailabilitySchema/);
    assert.doesNotMatch(source, /initCrawlQueueSchema/);
    assert.doesNotMatch(source, /ensureListingSemantics/);
    assert.doesNotMatch(source, /\binitDb\b/);
    assert.doesNotMatch(source, /initPostgresSearchSchema/);
  }
});

test('integration tests never drop the shared listings table', async () => {
  const files = (await readdir(testsDir))
    .filter((name) => name.endsWith('.integration.test.js'));

  for (const file of files) {
    const source = await readFile(new URL(file, testsDir), 'utf8');
    assert.doesNotMatch(
      source,
      /\bDROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:public\.)?listings\b/i,
      `${file} must isolate migration fixtures instead of dropping shared listings`,
    );
  }
});
