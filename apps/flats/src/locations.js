import {
  GENERIC_LANDMARK_TERMS,
  aliasesOf,
  aliasesToRegex,
} from '@whiteslove/parsing-lexicon';
import {
  matchTashkentHousingLandmarks,
  matchTashkentHousingMetro,
  matchTashkentHousingTransit,
  matchTashkentNumberedArea,
} from '@whiteslove/parsing-lexicon/tashkent-housing-geography';
import { resolveTashkentArea } from './tashkent-areas.js';
import {
  canonicalDictionaryDistrict,
  dictionaryLocationLists,
  matchDictionaryEntities,
} from './location-dictionary-resolver.js';

const GENERIC_NEARBY = GENERIC_LANDMARK_TERMS.map((item) => ({
  name: item.canonical,
  re: aliasesToRegex([item.canonical, ...aliasesOf(item)]),
}));

function explicitTashkentMetro(text) {
  const transit = matchTashkentHousingTransit(text);
  if (transit) return transit.name;

  const explicit = String(text).match(/(?:метро|metro|м\.)\s*[:\-–—]?\s*([^\n,.;]{2,52})/iu)?.[1] || '';
  if (explicit) {
    const station = matchTashkentHousingMetro(explicit);
    if (station) return station.name;
  }

  const beforeMarker = String(text).match(/(?:^|[^\p{L}\p{N}_])([\p{L}'’`-]{3,28})\s+metro(?:da|ga)?(?=$|[^\p{L}\p{N}_])/iu)?.[1] || '';
  if (beforeMarker) {
    const station = matchTashkentHousingMetro(beforeMarker);
    if (station) return station.name;
  }
  return null;
}

function applyPoiAdministrativeContext(result, text, countryCode, preferredCity) {
  if (countryCode !== 'UA') return;
  const city = preferredCity || result.city || '';
  if (city !== 'Chernivtsi') return;

  // Resolve the entity in ordered steps: first establish that the word belongs
  // to a named POI, then remove a district inference made from the same token.
  // Do not broaden the district regex to encode this exception.
  const mentionsZhovtnevyiPark = /парк\s+жовтнев(?:ий|ого|ому|им)/iu.test(String(text));
  if (!mentionsZhovtnevyiPark) return;

  const districtKey = String(result.district || '').toLocaleLowerCase();
  if (districtKey === 'zhovtnevyi' || districtKey === 'жовтневий' || districtKey === 'жовтневый') {
    result.district = null;
  }

  const entity = {
    type: 'historicalDistrict',
    name: 'Shevchenkivskyi',
    source: 'poiContext',
    relatedTo: 'Парк Жовтневий',
  };
  const exists = result.locationEntities.some(
    (item) => item?.type === entity.type && item?.name === entity.name,
  );
  if (!exists) result.locationEntities.push(entity);
}

export function parseLocation(text, countryCode, preferredCity = null) {
  const result = {
    region: null,
    district: null,
    microdistrict: null,
    residentialComplex: null,
    street: null,
    area: null,
    areaAmbiguous: false,
    locationConfidence: null,
    requireExactAddress: false,
    metro: null,
    landmarkCategory: null,
    nearby: [],
    city: null,
    locality: null,
    mahallas: [],
    localAreas: [],
    suburbs: [],
    settlements: [],
    informalAreas: [],
    developmentAreas: [],
    searchClusters: [],
    locationEntities: [],
  };
  if (!text) return result;

  const dictionary = matchDictionaryEntities(text, countryCode, preferredCity);
  result.region = dictionary.region;
  result.microdistrict = dictionary.microdistrict;
  result.residentialComplex = dictionary.residentialComplex;
  result.street = dictionary.street;
  result.city = dictionary.city;
  result.district = dictionary.district;
  result.metro = dictionary.metro;
  result.landmarkCategory = dictionary.landmarkCategory || null;
  result.locality = dictionary.locality || null;
  result.mahallas = [...(dictionary.mahallas || [])];
  // Existing Listing persistence already stores localAreas and locationEntities.
  // Mirror mahallas into localAreas for backward-compatible filtering while
  // retaining the precise `mahalla` type in locationEntities.
  result.localAreas = [...new Set([...(dictionary.localAreas || []), ...(dictionary.mahallas || [])])];
  result.suburbs = [...(dictionary.suburbs || [])];
  result.settlements = [...(dictionary.settlements || [])];
  result.informalAreas = [...(dictionary.informalAreas || [])];
  result.developmentAreas = [...(dictionary.developmentAreas || [])];
  result.searchClusters = [...(dictionary.searchClusters || [])];
  result.locationEntities = [...(dictionary.locationEntities || [])];
  // The housing-transit catalogue and the general POI catalogue both cover
  // Tashkent's railway stations, sometimes under different canonical names for
  // the same phrase (e.g. "Ташкент Северный вокзал"). Defer adding a railway
  // landmark until the explicit-metro check below has a chance to claim it,
  // so a listing doesn't end up with two conflicting station names.
  const dictionaryLandmarkIsRailway = dictionary.landmark && dictionary.landmarkCategory === 'railway';
  if (dictionary.landmark && !dictionaryLandmarkIsRailway) result.nearby.push(dictionary.landmark);

  // Tashkent's colloquial area resolver keeps only ambiguity/district policy;
  // all place names and spelling variants come from the shared package.
  if (countryCode === 'UZ') {
    const resolvedArea = resolveTashkentArea(text);
    if (resolvedArea) {
      result.area = resolvedArea.area;
      result.district = resolvedArea.district || result.district;
      result.areaAmbiguous = resolvedArea.ambiguous;
      result.locationConfidence = resolvedArea.confidence;
      result.requireExactAddress = resolvedArea.requireExactAddress;
      result.city = 'Tashkent';
    }

    const explicitMetro = explicitTashkentMetro(text);
    if (explicitMetro) {
      result.metro = explicitMetro;
      result.nearby = result.nearby.filter((name) => name !== explicitMetro && !(explicitMetro === 'Tashkent North Railway Station' && name === 'Railway station'));
    } else if (dictionaryLandmarkIsRailway && !result.nearby.includes(dictionary.landmark)) {
      result.nearby.push(dictionary.landmark);
    }
    if (result.metro === 'Chilonzor' && matchTashkentNumberedArea(text, 'Chilanzar') && explicitMetro !== 'Chilonzor') {
      result.metro = null;
    }

    for (const landmark of matchTashkentHousingLandmarks(text)) {
      result.city ||= 'Tashkent';
      if (!result.nearby.includes(landmark.name)) result.nearby.push(landmark.name);
    }
  } else if (dictionaryLandmarkIsRailway && !result.nearby.includes(dictionary.landmark)) {
    result.nearby.push(dictionary.landmark);
  }

  applyPoiAdministrativeContext(result, text, countryCode, preferredCity);

  for (const item of GENERIC_NEARBY) {
    if (item.name === 'Metro') continue;
    if (item.name === 'Railway station' && result.metro === 'Tashkent North Railway Station') continue;
    if (item.name === 'Market' && result.nearby.some((name) => /Bazaar$/i.test(name))) continue;
    if (result.nearby.length >= 6) break;
    if (item.name === 'Park' && result.nearby.some((name) => /Park$/i.test(name))) continue;
    if (item.re.test(text) && !result.nearby.includes(item.name)) result.nearby.push(item.name);
  }
  return result;
}

export function canonicalDistrict(name, countryCode) {
  if (!name || typeof name !== 'string') return name || null;
  return canonicalDictionaryDistrict(name, countryCode) || name;
}

export function cityLocations(countryCode) {
  const extended = dictionaryLocationLists(countryCode);
  return Object.fromEntries(Object.entries(extended).map(([city, data]) => [city, {
    districts: [...new Set(data.districts || [])],
    metro: [...new Set(data.metro || [])],
    microdistricts: [...new Set(data.microdistricts || [])],
    mahallas: [...new Set(data.mahallas || [])],
    localAreas: [...new Set(data.localAreas || [])],
    suburbs: [...new Set(data.suburbs || [])],
    settlements: [...new Set(data.settlements || [])],
    residentialComplexes: [...new Set(data.residentialComplexes || [])],
    streets: [...new Set(data.streets || [])],
    landmarks: [...new Set(data.landmarks || [])],
    ...(data.metroLabels ? { metroLabels: data.metroLabels } : {}),
    ...(data.poiGroups ? { poiGroups: data.poiGroups } : {}),
    ...(data.metropolitanEntities ? { metropolitanEntities: data.metropolitanEntities } : {}),
    ...(data.searchClusters ? { searchClusters: data.searchClusters } : {}),
  }]));
}
