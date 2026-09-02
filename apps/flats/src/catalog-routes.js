import {canonicalCityName, COUNTRIES, COUNTRY_CODES} from './countries.js';
import {cityLocations} from './locations.js';
import {getAvailableListingLocations} from './infrastructure/database/listingRepository.js';
import {getRates} from './fx.js';
import {mapZonesFor} from './district-zones.js';
import {geographyDisplayName} from '@whiteslove/parsing-lexicon/geography-display';
import {dictionaryFor} from '@whiteslove/parsing-lexicon/locations';

/**
 * Presentation adapter over parsing-lexicon's canonical location aliases.
 * No geography vocabulary is owned here: raw values stay canonical for API
 * filtering, while clients receive a parallel raw -> localized label map.
 */
const LOCATION_KIND_KEYS = Object.freeze({
  district: ['districts'],
  microdistrict: ['microdistricts'],
  metro: ['metro'],
  mahalla: ['mahallas'],
  local_area: ['localAreas', 'developmentAreas'],
});

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
// Prefer Russian-script aliases over Ukrainian/Uzbek/Kazakh Cyrillic when a
// canonical entry contains several Cyrillic language variants.
const NON_RUSSIAN_CYRILLIC_RE = /[ІіЇїЄєҐґЎўҚқҒғҲҳӘәӨөҰұҮүҢң]/u;

function preferredLexiconAlias(entry, locale) {
  const language = String(locale || 'en').toLowerCase().split(/[-_]/)[0];
  if (language !== 'ru') return entry?.canonical || entry?.name || null;
  const aliases = (entry?.aliases || []).map((value) => String(value).trim()).filter(Boolean);
  return aliases.find((alias) => CYRILLIC_RE.test(alias) && !NON_RUSSIAN_CYRILLIC_RE.test(alias))
    || aliases.find((alias) => CYRILLIC_RE.test(alias))
    || entry?.canonical
    || entry?.name
    || null;
}

function numberedMicrodistrictLabel(name, locale) {
  const raw = String(name || '').trim();
  const match = raw.match(/^(.+?)[\s-]+(\d{1,2}[A-Za-zА-Яа-я]?)$/u);
  if (!match) return null;
  const base = geographyDisplayName(match[1], locale, 'district');
  return base && base !== match[1] ? `${base}-${match[2]}` : null;
}

function lexiconLocationLabel(name, locale, kind, countryCode, cityName) {
  const raw = String(name || '').trim();
  if (!raw) return '';

  // Keep the package's curated display tables first where they exist.
  if (kind === 'district' || kind === 'microdistrict' || kind === 'metro') {
    const direct = geographyDisplayName(raw, locale, kind);
    if (direct && direct !== raw) return direct;
    if (kind === 'microdistrict') {
      const numbered = numberedMicrodistrictLabel(raw, locale);
      if (numbered) return numbered;
    }
  }

  const dictionary = dictionaryFor(countryCode, cityName);
  const keys = LOCATION_KIND_KEYS[kind] || [];
  for (const key of keys) {
    const entry = (dictionary?.[key] || []).find((candidate) =>
      candidate?.canonical === raw
      || candidate?.name === raw
      || candidate?.aliases?.includes(raw));
    if (!entry) continue;
    return preferredLexiconAlias(entry, locale) || raw;
  }
  return raw;
}

/** {raw name -> localized label}, only for names that actually translate. */
function labelMap(names, locale, kind, countryCode = '', cityName = '') {
  const map = {};
  for (const name of names) {
    const label = LOCATION_KIND_KEYS[kind]
      ? lexiconLocationLabel(name, locale, kind, countryCode, cityName)
      : geographyDisplayName(name, locale, kind);
    if (label && label !== name) map[name] = label;
  }
  return map;
}

function localizedMapZones(zones, locale, countryCode, cityName) {
  if (!locale) return zones;
  const mapGroup = (items, kind) => items.map((zone) => ({
    ...zone,
    label: lexiconLocationLabel(zone.name, locale, kind, countryCode, cityName),
  }));
  const mapPoiGroup = (items) => items.map((zone) => ({
    ...zone,
    label: geographyDisplayName(zone.name, locale, 'poi') || zone.name,
  }));
  return {
    ...zones,
    districtZones: mapGroup(zones.districtZones || [], 'district'),
    microdistrictMarkers: mapGroup(zones.microdistrictMarkers || [], 'microdistrict'),
    quartalMarkers: mapGroup(zones.quartalMarkers || [], 'mahalla'),
    areaZones: mapGroup(zones.areaZones || [], 'local_area'),
    metroStations: mapGroup(zones.metroStations || [], 'metro'),
    parks: mapPoiGroup(zones.parks || []),
    shoppingMalls: mapPoiGroup(zones.shoppingMalls || []),
    universities: mapPoiGroup(zones.universities || []),
    cityZone: zones.cityZone
      ? {...zones.cityZone, label: geographyDisplayName(zones.cityZone.name, locale, 'city')}
      : null,
  };
}

export function installCatalogRoutes(app) {
  app.get('/api/countries', async (req, res) => {
    // Clients (the app in particular) render raw geography names as-is by
    // default — OK for Romania/Kazakhstan/Uzbekistan's small Latin-script
    // lists, wrong for a Russian-language UI. Locale is opt-in via query
    // param rather than always computed, since it's extra work for every
    // city/district/metro/microdistrict/quartal/area name in every country.
    const locale = String(req.query.locale || '').trim();
    try {
      const result = await Promise.all(
        COUNTRY_CODES.map(async (code) => {
          const country = COUNTRIES[code];
          const locations = cityLocations(code);
          const cities = new Set(country.crawlCities ?? []);

          try {
            const rows = await getAvailableListingLocations(code);

            for (const row of rows) {
              const city = canonicalCityName(code, row.city);
              if (!city) continue;

              cities.add(city);
              if (!locations[city]) {
                locations[city] = {districts: [], metro: []};
              }

              const district = String(row.district ?? '').trim();
              if (district && !locations[city].districts.includes(district)) {
                locations[city].districts.push(district);
              }
            }
          } catch (err) {
            console.warn(
              `[locations] ${code} dynamic locations failed: ${err?.message ?? err}`,
            );
          }

          for (const [cityName, location] of Object.entries(locations)) {
            location.districts = [...new Set(location.districts ?? [])]
              .sort((a, b) => a.localeCompare(b, 'uk'));
            location.metro = [...new Set(location.metro ?? [])]
              .sort((a, b) => a.localeCompare(b, 'uk'));

            // Expose the selectable structured sub-city entities that the web
            // client gets from geo-catalog. Flutter consumes these names as
            // filters instead of treating them as arbitrary keyword search.
            const zones = mapZonesFor(code, cityName, location.districts);
            location.microdistricts = zones.microdistrictMarkers.map((item) => item.name);
            location.quartals = zones.quartalMarkers.map((item) => item.name);
            location.areas = zones.areaZones.map((item) => item.name);
            // Keep station choices in sync with the canonical map layer too;
            // source-maintained lists may be incomplete for a city.
            location.metro = [...new Set([
              ...location.metro,
              ...zones.metroStations.map((item) => item.name),
            ])].sort((a, b) => a.localeCompare(b, 'uk'));

            if (locale) {
              location.districtLabels = labelMap(location.districts, locale, 'district', code, cityName);
              location.metroLabels = labelMap(location.metro, locale, 'metro', code, cityName);
              location.microdistrictLabels = labelMap(location.microdistricts, locale, 'microdistrict', code, cityName);
              location.quartalLabels = labelMap(location.quartals, locale, 'mahalla', code, cityName);
              location.areaLabels = labelMap(location.areas, locale, 'local_area', code, cityName);
            }
          }

          const citiesList = [...cities].sort((a, b) => a.localeCompare(b, 'uk'));

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
        }),
      );

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
      const locale = String(req.query.locale || '').trim();
      const locations = cityLocations(country);
      const districtOptions = locations[city]?.districts ?? [];
      const zones = mapZonesFor(country, city, districtOptions);
      return res.json(localizedMapZones(zones, locale, country, city));
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
