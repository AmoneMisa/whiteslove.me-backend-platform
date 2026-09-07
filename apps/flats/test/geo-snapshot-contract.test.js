import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  localizedLocationOptions,
  locationOptionsFromZones,
} from '../src/geo/catalog-presentation.js';

const catalogRoutesSource = readFileSync(
  new URL('../src/routes/catalog-routes.js', import.meta.url),
  'utf8',
);
const snapshotSyncSource = readFileSync(
  new URL('../src/geo/geo-city-snapshot-sync.js', import.meta.url),
  'utf8',
);
const projectionWriterSource = readFileSync(
  new URL('../src/infrastructure/database/geoProjectionWriter.js', import.meta.url),
  'utf8',
);
const strictSyncCliSource = readFileSync(
  new URL('../src/sync-geo-snapshots.js', import.meta.url),
  'utf8',
);
const snapshotRepositorySource = readFileSync(
  new URL('../src/infrastructure/database/geoSnapshotRepository.js', import.meta.url),
  'utf8',
);
const migrationSource = readFileSync(
  new URL('../migrations/045_geo_city_snapshots.sql', import.meta.url),
  'utf8',
);
const geoComposeSource = readFileSync(
  new URL('../../../docker-compose.geo.yml', import.meta.url),
  'utf8',
);
const deploySource = readFileSync(
  new URL('../../../deploy.sh', import.meta.url),
  'utf8',
);

test('catalog request path reads persisted geo projection instead of rebuilding catalogs', () => {
  assert.match(catalogRoutesSource, /listGeoCityOptions/);
  assert.match(catalogRoutesSource, /loadGeoCityZones/);
  assert.doesNotMatch(catalogRoutesSource, /from ['"]\.\.\/geo\/district-zones\.js['"]/);
  assert.doesNotMatch(catalogRoutesSource, /^\s*const\s+zones\s*=\s*mapZonesFor\(/m);
  assert.doesNotMatch(catalogRoutesSource, /getAvailableListingLocations/);
  assert.match(catalogRoutesSource, /Geo snapshot is warming/);
});

test('worker snapshot builder owns expensive geo construction and writes one atomic projection', () => {
  assert.match(snapshotSyncSource, /mapZonesFor/);
  assert.match(snapshotSyncSource, /getAvailableListingLocations/);
  assert.match(snapshotSyncSource, /upsertGeoCityProjection/);
  assert.doesNotMatch(snapshotSyncSource, /upsertGeoCityZones/);
  assert.doesNotMatch(snapshotSyncSource, /upsertGeoCityOptions/);
  assert.match(snapshotSyncSource, /setImmediate/);
});

test('city map and selector rows are updated atomically and verified by content hash', () => {
  assert.match(projectionWriterSource, /WITH zones_upsert AS/);
  assert.match(projectionWriterSource, /options_upsert AS/);
  assert.match(projectionWriterSource, /CROSS JOIN options_upsert/);
  assert.match(projectionWriterSource, /snapshot\.source_hash = expected\.zones_hash/);
  assert.match(projectionWriterSource, /option_row\.source_hash = expected\.options_hash/);
  assert.match(snapshotSyncSource, /verifyGeoCityProjectionVersions/);
  assert.match(snapshotSyncSource, /zonesHash/);
  assert.match(snapshotSyncSource, /optionsHash/);
});

test('background geo refresh never prunes a country after incomplete dynamic collection', () => {
  assert.match(snapshotSyncSource, /dynamicAvailable/);
  assert.match(snapshotSyncSource, /skippedPruneCountries/);
  assert.match(snapshotSyncSource, /deleteGeoCityProjectionNotInCountry/);
  assert.match(snapshotRepositorySource, /WHERE snapshot\.country = \$1/);
  assert.match(snapshotRepositorySource, /WHERE option_row\.country = \$1/);
});

test('deployment geo prewarm is strict and verifies both read models', () => {
  assert.match(strictSyncCliSource, /strict:\s*true/);
  assert.match(strictSyncCliSource, /verify:\s*true/);
  assert.match(strictSyncCliSource, /prewarm skipped/);
  assert.match(snapshotSyncSource, /verifyGeoCityProjectionVersions/);
  assert.match(snapshotSyncSource, /projection verification failed/);
});

test('geo migration separates heavy map JSONB from compact selector arrays', () => {
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS geo_city_snapshots/);
  assert.match(migrationSource, /zones JSONB NOT NULL/);
  assert.doesNotMatch(migrationSource, /payload JSONB NOT NULL/);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS geo_city_options/);
  assert.match(migrationSource, /districts TEXT\[\] NOT NULL/);
  assert.match(migrationSource, /metro TEXT\[\] NOT NULL/);
  assert.match(migrationSource, /microdistricts TEXT\[\] NOT NULL/);
  assert.match(migrationSource, /quartals TEXT\[\] NOT NULL/);
  assert.match(migrationSource, /areas TEXT\[\] NOT NULL/);
  assert.match(migrationSource, /PRIMARY KEY \(country, city, locale\)/);
  assert.match(migrationSource, /source_hash VARCHAR\(64\) NOT NULL/);
});

test('countries selector query never reads the map JSONB table', () => {
  const listOptionsMatch = snapshotRepositorySource.match(
    /export async function listGeoCityOptions[\s\S]+?return result\.rows\.map/,
  );
  assert.ok(listOptionsMatch);
  assert.match(listOptionsMatch[0], /FROM geo_city_options/);
  assert.doesNotMatch(listOptionsMatch[0], /geo_city_snapshots/);
  assert.doesNotMatch(listOptionsMatch[0], /JSONB|payload|zones/);
});

test('flats deploy prewarms geo before api cutover and smoke-checks Tashkent', () => {
  assert.match(geoComposeSource, /flats-geo-sync:/);
  assert.match(geoComposeSource, /src\/sync-geo-snapshots\.js/);
  assert.match(deploySource, /flats phase 1\/5: migrate schema/);
  assert.match(deploySource, /flats phase 2\/5: strict geo prewarm/);
  assert.match(deploySource, /flats phase 3\/5: cut over flats-api/);
  assert.match(deploySource, /flats phase 4\/5: smoke materialized geo endpoints/);
  assert.match(deploySource, /flats phase 5\/5: cut over flats-worker/);
  assert.match(deploySource, /api\/countries\?locale=ru/);
  assert.match(deploySource, /api\/district-zones\?country=UZ/);

  const migrateAt = deploySource.indexOf('flats phase 1/5: migrate schema');
  const prewarmAt = deploySource.indexOf('flats phase 2/5: strict geo prewarm');
  const apiAt = deploySource.indexOf('flats phase 3/5: cut over flats-api');
  const smokeAt = deploySource.indexOf('flats phase 4/5: smoke materialized geo endpoints');
  const workerAt = deploySource.indexOf('flats phase 5/5: cut over flats-worker');
  assert.ok(migrateAt < prewarmAt && prewarmAt < apiAt && apiAt < smokeAt && smokeAt < workerAt);
});

test('selectable city options are derived once from the map contract', () => {
  const options = locationOptionsFromZones(
    {districts: ['B', 'A', 'A'], metro: ['Static']},
    {
      metroStations: [{name: 'Static'}, {name: 'Canonical'}],
      microdistrictMarkers: [{name: 'M1'}],
      quartalMarkers: [{name: 'Q1'}],
      areaZones: [{name: 'Area 1'}],
    },
  );

  assert.deepEqual(options.districts, ['A', 'B']);
  assert.deepEqual(options.metro, ['Canonical', 'Static']);
  assert.deepEqual(options.microdistricts, ['M1']);
  assert.deepEqual(options.quartals, ['Q1']);
  assert.deepEqual(options.areas, ['Area 1']);

  const localized = localizedLocationOptions(options, '', 'UZ', 'Tashkent');
  assert.deepEqual(localized, options);
});
