import {COUNTRIES, COUNTRY_CODES} from '../geo/countries.js';
import {cityLocations} from '../geo/locations.js';
import {
  labelMap,
  localizedLocationOptions,
  localizedMapZones,
} from '../geo/catalog-presentation.js';
import {
  listGeoCityOptions,
  loadGeoCityZones,
} from '../infrastructure/database/geoSnapshotRepository.js';
import {getRates} from '../support/fx.js';

function optionRowsByCity(rows) {
  const map = new Map();
  for (const row of rows || []) {
    map.set(`${row.country}\0${row.city}`, row);
  }
  return map;
}

function staticLocationOptions(countryCode, cityName, locale) {
  const location = cityLocations(countryCode)?.[cityName] || {};
  return localizedLocationOptions({
    districts: location.districts || [],
    metro: location.metro || [],
    microdistricts: [],
    quartals: [],
    areas: [],
  }, locale, countryCode, cityName);
}

export function installCatalogRoutes(app) {
  app.get('/api/countries', async (req, res) => {
    const locale = String(req.query.locale || '').trim().toLowerCase();
    try {
      const exactRows = await listGeoCityOptions(locale);
      const canonicalRows = locale ? await listGeoCityOptions('') : exactRows;
      const exactByCity = optionRowsByCity(exactRows);
      const canonicalByCity = optionRowsByCity(canonicalRows);

      const result = COUNTRY_CODES.map((code) => {
        const country = COUNTRIES[code];
        const staticLocations = cityLocations(code) || {};
        const cities = new Set([
          ...(country.crawlCities || []),
          ...Object.keys(staticLocations),
        ]);

        for (const row of canonicalRows) {
          if (row.country === code) cities.add(row.city);
        }
        for (const row of exactRows) {
          if (row.country === code) cities.add(row.city);
        }

        const citiesList = [...cities].sort((a, b) => a.localeCompare(b, 'uk'));
        const locations = {};
        for (const cityName of citiesList) {
          const key = `${code}\0${cityName}`;
          const exact = exactByCity.get(key);
          const canonical = canonicalByCity.get(key);
          if (exact?.options) {
            locations[cityName] = exact.options;
          } else if (canonical?.options) {
            locations[cityName] = localizedLocationOptions(
              canonical.options,
              locale,
              code,
              cityName,
            );
          } else {
            // A brand-new city can appear between worker snapshot refreshes.
            // Preserve the basic static selectors without rebuilding the geo
            // catalog synchronously in the API process.
            locations[cityName] = staticLocationOptions(code, cityName, locale);
          }
        }

        return {
          code: country.code,
          name: country.name,
          currency: country.currency,
          callingCode: country.callingCode ?? null,
          center: country.center,
          cities: citiesList,
          ...(locale ? {cityLabels: labelMap(citiesList, locale, 'city')} : {}),
          locations,
        };
      });

      return res.json(result);
    } catch (err) {
      return res.status(500).json({
        error: err?.message ?? String(err),
      });
    }
  });

  app.get('/api/district-zones', async (req, res) => {
    try {
      const country = String(req.query.country || '').toUpperCase();
      const city = String(req.query.city || '').trim();
      if (!country || !city) {
        return res.status(400).json({error: 'country and city are required'});
      }

      const locale = String(req.query.locale || '').trim().toLowerCase();
      const exact = await loadGeoCityZones(country, city, locale);
      if (exact?.zones) return res.json(exact.zones);

      if (locale) {
        const canonical = await loadGeoCityZones(country, city, '');
        if (canonical?.zones) {
          return res.json(localizedMapZones(canonical.zones, locale, country, city));
        }
      }

      // Never fall back to mapZonesFor() here: snapshot construction is
      // deliberately worker-owned so one cold request cannot monopolize the
      // API event loop again.
      return res.status(503).json({
        error: 'Geo snapshot is warming',
        warming: true,
        country,
        city,
      });
    } catch (err) {
      return res.status(500).json({error: err?.message ?? String(err)});
    }
  });

  app.get('/api/rates', async (_req, res) => {
    try {
      const {base, rates, at} = await getRates();
      return res.json({
        base,
        rates,
        fetchedAt: new Date(at).toISOString(),
      });
    } catch (err) {
      return res.status(500).json({error: err.message});
    }
  });
}
