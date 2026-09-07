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
const migrationSource = readFileSync(
  new URL('../migrations/045_geo_city_snapshots.sql', import.meta.url),
  'utf8',
);

test('catalog request path reads persisted geo projection instead of rebuilding catalogs', () => {
  assert.match(catalogRoutesSource, /listGeoCityOptions/);
  assert.match(catalogRoutesSource, /loadGeoCitySnapshot/);
  assert.doesNotMatch(catalogRoutesSource, /mapZonesFor/);
  assert.doesNotMatch(catalogRoutesSource, /getAvailableListingLocations/);
  assert.match(catalogRoutesSource, /Geo snapshot is warming/);
});

test('worker snapshot builder owns expensive geo construction and dynamic location merge', () => {
  assert.match(snapshotSyncSource, /mapZonesFor/);
  assert.match(snapshotSyncSource, /getAvailableListingLocations/);
  assert.match(snapshotSyncSource, /upsertGeoCitySnapshot/);
  assert.match(snapshotSyncSource, /setImmediate/);
});

test('geo snapshot migration persists city and locale keyed JSONB', () => {
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS geo_city_snapshots/);
  assert.match(migrationSource, /payload JSONB NOT NULL/);
  assert.match(migrationSource, /PRIMARY KEY \(country, city, locale\)/);
  assert.match(migrationSource, /source_hash VARCHAR\(64\) NOT NULL/);
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
