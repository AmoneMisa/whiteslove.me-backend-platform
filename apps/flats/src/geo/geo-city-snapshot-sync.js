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
  deleteGeoCityProjectionNotInCountry,
  upsertGeoCityOptions,
  upsertGeoCityZones,
  verifyGeoCityProjection,
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

async function collectCountryLocations(countryCode, {strict = false} = {}) {
  const locations = cloneLocations(countryCode);
  const cities = new Set([
    ...(COUNTRIES[countryCode]?.crawlCities || []),
    ...Object.keys(locations),
  ]);
  let dynamicAvailable = true;

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
    dynamicAvailable = false;
    const message = `[geo-snapshot] ${countryCode} dynamic locations unavailable: ${error?.message ?? error}`;
    if (strict) throw new Error(message, {cause: error});
    console.warn(message);
  }

  for (const city of cities) ensureLocation(locations, city);
  return {
    cities: [...cities].sort((a, b) => a.localeCompare(b, 'uk')),
    locations,
    dynamicAvailable,
  };
}

function contentHash(kind, data) {
  return createHash('sha256')
    .update(JSON.stringify({schemaVersion: SNAPSHOT_SCHEMA_VERSION, kind, data}))
    .digest('hex');
}

async function buildAllSnapshots({strict = false, verify = true} = {}) {
  const locales = snapshotLocales();
  const keep = [];
  const countryInputs = new Map();
  const skippedPruneCountries = [];
  let snapshots = 0;
  let cities = 0;
  let deletedSnapshots = 0;
  let deletedOptions = 0;
  const startedAt = performance.now();

  // In strict deployment-prewarm mode, collect every dynamic source before the
  // first projection write. A transient DB/source failure then fails the gate
  // without partially pruning an otherwise good production projection.
  for (const country of COUNTRY_CODES) {
    countryInputs.set(country, await collectCountryLocations(country, {strict}));
  }

  for (const country of COUNTRY_CODES) {
    const input = countryInputs.get(country);
    const countryKeep = [];

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

        const key = {country, city, locale};
        keep.push(key);
        countryKeep.push(key);
        snapshots += 1;
      }

      // Snapshot construction is worker-owned, but yielding between cities
      // keeps queue lease renewals and other worker timers responsive.
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (input.dynamicAvailable) {
      const deleted = await deleteGeoCityProjectionNotInCountry(country, countryKeep);
      deletedSnapshots += deleted.snapshots;
      deletedOptions += deleted.options;
    } else {
      // Keep the previous good rows for dynamic/listing-only cities until a
      // later refresh can read the complete source again.
      skippedPruneCountries.push(country);
    }
  }

  const coverage = verify
    ? await verifyGeoCityProjection(keep)
    : {expected: keep.length, snapshots: keep.length, options: keep.length, missing: []};

  if (coverage.missing.length) {
    const preview = coverage.missing.slice(0, 5);
    throw new Error(
      `geo projection verification failed: ${coverage.missing.length} missing rows ` +
      `${JSON.stringify(preview)}`,
    );
  }

  return {
    cities,
    snapshots,
    deleted: deletedSnapshots + deletedOptions,
    deletedSnapshots,
    deletedOptions,
    locales,
    strict,
    verified: coverage.expected,
    skippedPruneCountries,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

export async function syncGeoCitySnapshots(options = {}) {
  const locked = await withGeoSnapshotBuildLock(() => buildAllSnapshots(options));
  if (!locked.locked) return {skipped: true, reason: 'locked'};
  return {skipped: false, ...locked.result};
}
