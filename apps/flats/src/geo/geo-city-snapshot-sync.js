import {createHash} from 'node:crypto';

import {canonicalCityName, COUNTRIES, COUNTRY_CODES} from './countries.js';
import {cityLocations} from './locations.js';
import {mapZonesFor} from './district-zones.js';
import {
  localizedLocationOptions,
  localizedMapZones,
  locationOptionsFromZones,
} from './catalog-presentation.js';
import {getAvailableListingLocations} from '../infrastructure/database/listingRepository.js';
import {
  deleteGeoCityProjectionNotIn,
  upsertGeoCityOptions,
  upsertGeoCityZones,
  withGeoSnapshotBuildLock,
} from '../infrastructure/database/geoSnapshotRepository.js';

const SNAPSHOT_SCHEMA_VERSION = 2;

function snapshotLocales() {
  const configured = String(process.env.GEO_SNAPSHOT_LOCALES || 'ru')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ['', ...new Set(configured)];
}

function cloneLocations(countryCode) {
  return Object.fromEntries(
    Object.entries(cityLocations(countryCode) || {}).map(([city, location]) => [city, {
      districts: [...(location?.districts || [])],
      metro: [...(location?.metro || [])],
    }]),
  );
}

function ensureLocation(locations, city) {
  if (!locations[city]) locations[city] = {districts: [], metro: []};
  return locations[city];
}

async function collectCountryLocations(countryCode) {
  const locations = cloneLocations(countryCode);
  const cities = new Set([
    ...(COUNTRIES[countryCode]?.crawlCities || []),
    ...Object.keys(locations),
  ]);

  try {
    const rows = await getAvailableListingLocations(countryCode);
    for (const row of rows) {
      const city = canonicalCityName(countryCode, row.city);
      if (!city) continue;
      cities.add(city);
      const location = ensureLocation(locations, city);
      const district = String(row.district || '').trim();
      if (district) location.districts.push(district);
    }
  } catch (error) {
    console.warn(
      `[geo-snapshot] ${countryCode} dynamic locations unavailable: ${error?.message ?? error}`,
    );
  }

  for (const city of cities) ensureLocation(locations, city);
  return {cities: [...cities].sort((a, b) => a.localeCompare(b, 'uk')), locations};
}

function contentHash(kind, data) {
  return createHash('sha256')
    .update(JSON.stringify({schemaVersion: SNAPSHOT_SCHEMA_VERSION, kind, data}))
    .digest('hex');
}

async function buildAllSnapshots() {
  const locales = snapshotLocales();
  const keep = [];
  let snapshots = 0;
  let cities = 0;
  const startedAt = performance.now();

  for (const country of COUNTRY_CODES) {
    const input = await collectCountryLocations(country);
    for (const city of input.cities) {
      const baseLocation = input.locations[city] || {districts: [], metro: []};
      const canonicalZones = mapZonesFor(country, city, baseLocation.districts);
      const canonicalOptions = locationOptionsFromZones(baseLocation, canonicalZones);
      cities += 1;

      for (const locale of locales) {
        const zones = localizedMapZones(canonicalZones, locale, country, city);
        const options = localizedLocationOptions(canonicalOptions, locale, country, city);

        await upsertGeoCityZones({
          country,
          city,
          locale,
          zones,
          sourceHash: contentHash('zones', zones),
        });
        await upsertGeoCityOptions({
          country,
          city,
          locale,
          options,
          sourceHash: contentHash('options', options),
        });
        keep.push({country, city, locale});
        snapshots += 1;
      }

      // Snapshot construction is worker-owned, but yielding between cities
      // keeps queue lease renewals and other worker timers responsive.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const deletedRows = await deleteGeoCityProjectionNotIn(keep);
  return {
    cities,
    snapshots,
    deleted: deletedRows.snapshots + deletedRows.options,
    deletedSnapshots: deletedRows.snapshots,
    deletedOptions: deletedRows.options,
    locales,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

export async function syncGeoCitySnapshots() {
  const locked = await withGeoSnapshotBuildLock(buildAllSnapshots);
  if (!locked.locked) return {skipped: true, reason: 'locked'};
  return {skipped: false, ...locked.result};
}
