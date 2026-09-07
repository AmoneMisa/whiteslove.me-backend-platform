import {geographyDisplayName} from '@whiteslove/parsing-lexicon/geography-display';
import {dictionaryFor} from '@whiteslove/parsing-lexicon/locations';

const LOCATION_KIND_KEYS = Object.freeze({
  district: ['districts'],
  microdistrict: ['microdistricts'],
  metro: ['metro'],
  mahalla: ['mahallas'],
  local_area: ['localAreas', 'developmentAreas'],
});

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
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

export function lexiconLocationLabel(name, locale, kind, countryCode, cityName) {
  const raw = String(name || '').trim();
  if (!raw) return '';

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

export function labelMap(names, locale, kind, countryCode = '', cityName = '') {
  const map = {};
  for (const name of names || []) {
    const label = LOCATION_KIND_KEYS[kind]
      ? lexiconLocationLabel(name, locale, kind, countryCode, cityName)
      : geographyDisplayName(name, locale, kind);
    if (label && label !== name) map[name] = label;
  }
  return map;
}

export function localizedMapZones(zones, locale, countryCode, cityName) {
  if (!locale) return zones;
  const mapGroup = (items, kind) => (items || []).map((zone) => ({
    ...zone,
    label: lexiconLocationLabel(zone.name, locale, kind, countryCode, cityName),
  }));
  const mapPoiGroup = (items) => (items || []).map((zone) => ({
    ...zone,
    label: geographyDisplayName(zone.name, locale, 'poi') || zone.name,
  }));
  return {
    ...zones,
    districtZones: mapGroup(zones.districtZones, 'district'),
    regionZones: mapGroup(zones.regionZones, 'region'),
    microdistrictMarkers: mapGroup(zones.microdistrictMarkers, 'microdistrict'),
    mahallaMarkers: mapGroup(zones.mahallaMarkers, 'mahalla'),
    quarterMarkers: mapGroup(zones.quarterMarkers, 'microdistrict'),
    quartalMarkers: mapGroup(zones.quartalMarkers, 'mahalla'),
    areaZones: mapGroup(zones.areaZones, 'local_area'),
    zoneMarkers: mapGroup(zones.zoneMarkers, 'local_area'),
    metroStations: mapGroup(zones.metroStations, 'metro'),
    parks: mapPoiGroup(zones.parks),
    shoppingMalls: mapPoiGroup(zones.shoppingMalls),
    universities: mapPoiGroup(zones.universities),
    schools: mapPoiGroup(zones.schools),
    residentialComplexes: mapPoiGroup(zones.residentialComplexes),
    airports: mapPoiGroup(zones.airports),
    railwayStations: mapPoiGroup(zones.railwayStations),
    busStations: mapPoiGroup(zones.busStations),
    transportStops: mapPoiGroup(zones.transportStops),
    parkings: mapPoiGroup(zones.parkings),
    cityZone: zones.cityZone
      ? {...zones.cityZone, label: geographyDisplayName(zones.cityZone.name, locale, 'city')}
      : null,
  };
}

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'uk'));
}

export function locationOptionsFromZones(baseLocation = {}, zones = {}) {
  const districts = uniqueSorted(baseLocation.districts);
  const metro = uniqueSorted([
    ...(baseLocation.metro || []),
    ...(zones.metroStations || []).map((item) => item.name),
  ]);
  return {
    districts,
    metro,
    microdistricts: uniqueSorted((zones.microdistrictMarkers || []).map((item) => item.name)),
    quartals: uniqueSorted((zones.quartalMarkers || []).map((item) => item.name)),
    areas: uniqueSorted((zones.areaZones || []).map((item) => item.name)),
  };
}

export function localizedLocationOptions(options, locale, countryCode, cityName) {
  const result = {
    districts: uniqueSorted(options?.districts),
    metro: uniqueSorted(options?.metro),
    microdistricts: uniqueSorted(options?.microdistricts),
    quartals: uniqueSorted(options?.quartals),
    areas: uniqueSorted(options?.areas),
  };
  if (!locale) return result;
  return {
    ...result,
    districtLabels: labelMap(result.districts, locale, 'district', countryCode, cityName),
    metroLabels: labelMap(result.metro, locale, 'metro', countryCode, cityName),
    microdistrictLabels: labelMap(result.microdistricts, locale, 'microdistrict', countryCode, cityName),
    quartalLabels: labelMap(result.quartals, locale, 'mahalla', countryCode, cityName),
    areaLabels: labelMap(result.areas, locale, 'local_area', countryCode, cityName),
  };
}
