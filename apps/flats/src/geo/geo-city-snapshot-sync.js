import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

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
  withGeoSnapshotBuildLock,
} from '../infrastructure/database/geoSnapshotRepository.js';
import {
  loadGeoCityProjectionInputHashes,
  upsertGeoCityProjection,
  verifyGeoCityProjectionVersions,
} from '../infrastructure/database/geoProjectionWriter.js';

const SNAPSHOT_SCHEMA_VERSION = 2;

// district-zones.js resolves every zone/marker through this package's pinned
// lexicon data. Folding its version into the input hash means a dependency
// bump forces a rebuild even though nothing else about a city changed.
const GEO_CATALOG_VERSION = createRequire(import.meta.url)('@whiteslove/geo-catalog/package.json').version;

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

// Cheap signature of everything that can change a city/locale's computed
// zones and options, available before doing any of that expensive work. A
// match against the previous build's stored input hash means the output would
// be identical, so the rebuild can skip straight to reusing it.
function cityInputHash(country, city, locale, baseLocation) {
  return contentHash('input', {
    geoCatalogVersion: GEO_CATALOG_VERSION,
    country,
    city,
    locale,
    districts: [...new Set(baseLocation.districts)].sort(),
    metro: [...new Set(baseLocation.metro)].sort(),
  });
}

async function buildAllSnapshots({strict = false, verify = true} = {}) {
  const locales = snapshotLocales();
  const keep = [];
  const countryInputs = new Map();
  const skippedPruneCountries = [];
  let snapshots = 0;
  let cities = 0;
  let skipped = 0;
  let deletedSnapshots = 0;
  let deletedOptions = 0;
  const startedAt = performance.now();

  // In strict deployment-prewarm mode, collect every dynamic source before the
  // first projection write. A transient DB/source failure then fails the gate
  // without partially pruning an otherwise good production projection.
  for (const country of COUNTRY_CODES) {
    countryInputs.set(country, await collectCountryLocations(country, {strict}));
  }

  const totalCities = [...countryInputs.values()]
    .reduce((sum, input) => sum + input.cities.length, 0);
  console.log(
    `[geo-snapshot] build started: ${totalCities} cities, ${locales.length} locales, strict=${strict}`,
  );

  for (const country of COUNTRY_CODES) {
    const input = countryInputs.get(country);
    const countryKeep = [];
    const countryStartedAt = performance.now();
    // Cheap signatures from the previous successful build. A city/locale whose
    // signature still matches would recompute to byte-identical zones/options,
    // so it can reuse those rows instead of paying for lexicon resolution again.
    const previousInputHashes = await loadGeoCityProjectionInputHashes(country);

    console.log(`[geo-snapshot] ${country} started: ${input.cities.length} cities`);

    for (const city of input.cities) {
      const cityStartedAt = performance.now();
      const baseLocation = input.locations[city] || {districts: [], metro: []};
      cities += 1;

      const localeChecks = locales.map((locale) => {
        const inputHash = cityInputHash(country, city, locale, baseLocation);
        const previous = previousInputHashes.get(`${city}\0${locale}`);
        return {locale, inputHash, previous, unchanged: previous?.inputHash === inputHash};
      });

      // mapZonesFor resolves every zone/marker through the lexicon and is the
      // expensive step observed to dominate build time; it does not depend on
      // locale. Skip it entirely when every configured locale for this city is
      // already up to date.
      let canonicalZones = null;
      let canonicalOptions = null;
      if (localeChecks.some((check) => !check.unchanged)) {
        canonicalZones = mapZonesFor(country, city, baseLocation.districts);
        canonicalOptions = locationOptionsFromZones(baseLocation, canonicalZones);
      }

      for (const check of localeChecks) {
        if (check.unchanged) {
          const key = {
            country,
            city,
            locale: check.locale,
            zonesHash: check.previous.zonesHash,
            optionsHash: check.previous.optionsHash,
          };
          keep.push(key);
          countryKeep.push(key);
          snapshots += 1;
          skipped += 1;
          continue;
        }

        const zones = localizedMapZones(canonicalZones, check.locale, country, city);
        const options = localizedLocationOptions(canonicalOptions, check.locale, country, city);
        const zonesHash = contentHash('zones', zones);
        const optionsHash = contentHash('options', options);

        // Map geometry and selector arrays are one logical read-model version.
        // Persist both in one atomic PostgreSQL statement so readers can never
        // observe a half-updated city/locale pair.
        await upsertGeoCityProjection({
          country,
          city,
          locale: check.locale,
          zones,
          zonesSourceHash: zonesHash,
          options,
          optionsSourceHash: optionsHash,
          inputHash: check.inputHash,
        });

        const key = {country, city, locale: check.locale, zonesHash, optionsHash};
        keep.push(key);
        countryKeep.push(key);
        snapshots += 1;
      }

      console.log(
        `[geo-snapshot] ${cities}/${totalCities} ${country}/${city} ` +
        `${Math.round(performance.now() - cityStartedAt)}ms`,
      );

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

    console.log(
      `[geo-snapshot] ${country} completed in ` +
      `${Math.round(performance.now() - countryStartedAt)}ms`,
    );
  }

  const coverage = verify
    ? await verifyGeoCityProjectionVersions(keep)
    : {expected: keep.length, snapshots: keep.length, options: keep.length, missing: []};

  if (coverage.missing.length) {
    const preview = coverage.missing.slice(0, 5);
    throw new Error(
      `geo projection verification failed: ${coverage.missing.length} missing/stale rows ` +
      `${JSON.stringify(preview)}`,
    );
  }

  return {
    cities,
    snapshots,
    // Rows whose input hash matched the previous build and were reused
    // unchanged, without recomputing zones/options. Named distinctly from the
    // build-lock `skipped` flag `syncGeoCitySnapshots` adds around this result.
    skippedCities: skipped,
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
