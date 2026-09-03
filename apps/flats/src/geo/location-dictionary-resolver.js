import {
  ODESA_METROPOLITAN_ENTITIES,
  ODESA_SEARCH_CLUSTERS,
  TASHKENT_LANDMARKS,
  TASHKENT_POI_GROUPS,
  TASHKENT_RESIDENTIAL_COMPLEXES,
  UA_MAJOR_LOCATION_EXTENSIONS,
  UA_METRO_LOCATION_EXTENSIONS,
  UA_REGION_ENTRIES as UA_REGIONS,
  UA_REGIONAL_LOCATION_EXTENSIONS,
  UA_SECONDARY_CITIES,
  centralAsiaLocationCities,
  locationCities,
  matchCentralAsiaLocationEntities,
  matchOdesaMetropolitanEntities,
  matchTashkentPoi,
  matchTashkentResidentialComplex,
  matchUkraineRegion,
  matchUkraineSecondaryCity,
  mergeLocationCountries,
  tashkentMetroLabels,
} from '@whiteslove/parsing-lexicon';
import { matchTashkentHousingTransit } from '@whiteslove/parsing-lexicon/tashkent-housing-geography';

let mergedUkraine = null;

function mergedCountry(countryCode) {
  if (countryCode === 'KZ' || countryCode === 'UZ') return centralAsiaLocationCities(countryCode);
  if (countryCode !== 'UA') return locationCities(countryCode);
  if (!mergedUkraine) {
    mergedUkraine = mergeLocationCountries(
      locationCities('UA'),
      UA_MAJOR_LOCATION_EXTENSIONS,
      UA_REGIONAL_LOCATION_EXTENSIONS,
      UA_METRO_LOCATION_EXTENSIONS,
    );
  }
  return mergedUkraine;
}

/** Hashtags can run location words together; split only camel-case hashtag tokens. */
function expandHashtags(text) {
  return String(text).replace(/#(\S+)/gu, (match, body) =>
    '#' + body.replace(/(\p{Ll}|\d)(\p{Lu})/gu, '$1 $2'),
  );
}

function normalizeMatchingText(text) {
  return expandHashtags(text)
    .replace(/([\p{L}]+?)ії(?=$|[^\p{L}\p{N}_])/giu, '$1ія')
    .replace(/([\p{L}]+?)ии(?=$|[^\p{L}\p{N}_])/giu, '$1ия')
    .replace(/([\p{L}]+?)щині(?=$|[^\p{L}\p{N}_])/giu, '$1щина')
    .replace(/([\p{L}]+?)щине(?=$|[^\p{L}\p{N}_])/giu, '$1щина');
}

function matchMetro(text, entries, overlappingAreaName = null) {
  const value = String(text);
  const matches = [];

  for (const entry of entries || []) {
    const match = value.match(entry.re);
    if (!match) continue;

    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = value.slice(Math.max(0, start - 28), start);
    const after = value.slice(end, end + 64);
    const contextual =
      /(?:метро|metrou|metro|станц(?:ия|ии)?|station|stația|statia|метро станція|станція|ст\.?\s*м\.?|м\.)\s*[:\-–—]?\s*$/iu.test(before) ||
      /^\s*(?:метро|metrou|metro|station|stația|statia|станція)(?=$|[^\p{L}\p{N}_])/iu.test(after);

    // Some names denote both a neighbourhood and a metro station. A bare
    // place name means the area; mark metro only when the text says metro/station.
    if (overlappingAreaName && entry.name === overlappingAreaName && !contextual) continue;

    // Numbered massifs/kvartals such as Chilonzor 12 / Yunusobod 19 are not subway mentions.
    const numberedArea = /^\s*[-№#]?\s*\d{1,3}(?=$|[\s,.;-])/u.test(after);
    if (!contextual && numberedArea) continue;

    if (entry.name === 'Toshkent' && matchTashkentHousingTransit(value.slice(start, end + 64))) continue;

    matches.push({ entry, contextual });
  }

  return matches.find((item) => item.contextual)?.entry ?? matches[0]?.entry ?? null;
}

function pushUnique(target, value) {
  if (value && !target.includes(value)) target.push(value);
}

function shouldResolveOdesaMetropolitan(text, preferredCity, resolvedCity) {
  if (preferredCity === 'Odesa' || resolvedCity === 'Odesa') return true;
  return /(?:^|[^\p{L}\p{N}_])(?:одеса|одесса|odesa|odessa)(?=$|[^\p{L}\p{N}_])/iu.test(String(text));
}

function applyOdesaMetropolitan(result, text) {
  const metropolitan = matchOdesaMetropolitanEntities(text);
  const contextualRivieraMall = metropolitan.matches.some((item) => item.type === 'poi.shopping_mall' && item.name === 'ТРЦ Рів’єра');

  // The broad city catalog contains Riviera as a discovery alias, while the
  // metropolitan resolver owns its context. Never let bare "Riviera" become
  // the mall in a ЖК/development-area mention.
  if (result.landmark === 'Riviera Mall' && !contextualRivieraMall) {
    result.landmark = null;
    result.landmarkCategory = null;
  }

  if (!metropolitan.matches.length) return;
  result.city ||= 'Odesa';

  for (const item of metropolitan.matches) {
    result.locationEntities.push({ type: item.type, name: item.name, parent: item.parent || null });

    if (item.type === 'microdistrict') result.microdistrict = item.name;
    else if (item.type === 'local_area') pushUnique(result.localAreas, item.name);
    else if (item.type === 'suburb') {
      pushUnique(result.suburbs, item.name);
      result.locality ||= item.name;
    } else if (item.type === 'informal_area') pushUnique(result.informalAreas, item.name);
    else if (item.type === 'development_area') pushUnique(result.developmentAreas, item.name);
    else if (item.type === 'residential_complex') result.residentialComplex = item.name;
    else if (item.type.startsWith('poi.') && !result.landmark) {
      result.landmark = item.name;
      result.landmarkCategory = item.type.slice(4) || null;
    }
  }

  for (const cluster of metropolitan.searchClusters) {
    pushUnique(result.searchClusters, cluster.name);
    result.locationEntities.push({ type: cluster.type, name: cluster.name, parent: null });
  }
}

function applyCentralAsiaLocations(result, central) {
  if (!central) return;
  if (central.city) result.city ||= central.city;

  for (const item of central.matches || []) {
    result.locationEntities.push({
      type: item.type,
      name: item.name,
      parent: item.parent || null,
      role: item.role || 'mentioned',
    });

    if (item.type === 'district' && !result.district) result.district = item.name;
    else if (item.type === 'microdistrict' && !result.microdistrict) result.microdistrict = item.name;
    else if (item.type === 'mahalla') {
      pushUnique(result.mahallas, item.name);
      // Keep the legacy flat location field populated while retaining the
      // more precise entity type in mahallas and locationEntities.
      result.microdistrict ||= item.name;
    }
    else if (item.type === 'local_area') pushUnique(result.localAreas, item.name);
    else if (item.type === 'suburb') {
      pushUnique(result.suburbs, item.name);
      result.locality ||= item.name;
    } else if (item.type === 'settlement') {
      pushUnique(result.settlements, item.name);
      result.locality ||= item.name;
    } else if (item.type === 'metro' && !result.metro) result.metro = item.name;
    else if (item.type === 'residential_complex' && !result.residentialComplex) result.residentialComplex = item.name;
    else if (item.type === 'street' && !result.street) result.street = item.name;
    else if (item.type === 'poi' && !result.landmark) {
      result.landmark = item.name;
      result.landmarkCategory = item.key === 'landmarks' ? 'poi' : item.key || 'poi';
    }
  }

  for (const cluster of central.searchClusters || []) {
    pushUnique(result.searchClusters, cluster.name);
    result.locationEntities.push({ type: cluster.type, name: cluster.name, parent: cluster.city || null });
  }
}

export function matchDictionaryEntities(text, countryCode, preferredCity = null) {
  const result = {
    region: null,
    city: null,
    district: null,
    microdistrict: null,
    metro: null,
    residentialComplex: null,
    street: null,
    landmark: null,
    landmarkCategory: null,
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
  if (!text || !countryCode) return result;
  text = normalizeMatchingText(text);

  if (countryCode === 'UA') {
    result.region = matchUkraineRegion(text)?.name || null;
    const secondary = matchUkraineSecondaryCity(text);
    if (secondary) {
      result.city = secondary.city;
      const micro = (secondary.microdistricts || []).find((x) => x.re.test(text));
      if (micro) result.microdistrict = micro.name;
    }
  }

  const central = countryCode === 'KZ' || countryCode === 'UZ'
    ? matchCentralAsiaLocationEntities(text, countryCode, preferredCity)
    : null;
  applyCentralAsiaLocations(result, central);

  const cities = mergedCountry(countryCode);
  if (countryCode === 'UZ') {
    const tashkentRc = matchTashkentResidentialComplex(text);
    const tashkentLandmark = matchTashkentPoi(text);
    if (tashkentRc || tashkentLandmark) {
      result.city ||= 'Tashkent';
      if (tashkentRc && !result.residentialComplex) result.residentialComplex = tashkentRc.name;
      if (tashkentLandmark && !result.landmark) {
        result.landmark = tashkentLandmark.name;
        result.landmarkCategory = tashkentLandmark.category || tashkentLandmark.entityType || null;
      }
    }
  }
  let ordered;
  const resolvedCity = central?.city || result.city;
  if (resolvedCity && cities[resolvedCity]) {
    ordered = [[resolvedCity, cities[resolvedCity]]];
  } else if (central?.candidates?.length) {
    // Parent-aware Central Asia resolver found only ambiguous city candidates.
    // Do not fall back to first-match-wins across the whole country.
    ordered = [];
  } else {
    ordered = preferredCity && cities[preferredCity]
      ? [[preferredCity, cities[preferredCity]], ...Object.entries(cities).filter(([name]) => name !== preferredCity)]
      : Object.entries(cities);
  }

  for (const [cityName, data] of ordered) {
    const district = (data.districts || []).find((x) => x.re.test(text));
    const microdistrict = (data.microdistricts || []).find((x) => x.re.test(text));
    const metro = matchMetro(text, data.metro, microdistrict?.name || null);
    const residentialComplex = countryCode === 'UZ' && cityName === 'Tashkent'
      ? matchTashkentResidentialComplex(text)
      : (data.residentialComplexes || []).find((x) => x.re.test(text));
    const street = (data.streets || []).find((x) => x.re.test(text));
    const landmark = countryCode === 'UZ' && cityName === 'Tashkent'
      ? matchTashkentPoi(text)
      : (data.landmarks || []).find((x) => x.re.test(text));

    if (!result.district && district) result.district = district.name;
    if (!result.microdistrict && microdistrict) result.microdistrict = microdistrict.name;
    if (!result.metro && metro) result.metro = metro.name;
    if (!result.residentialComplex && residentialComplex) result.residentialComplex = residentialComplex.name;
    if (!result.street && street) result.street = street.name;
    if (!result.landmark && landmark) {
      result.landmark = landmark.name;
      result.landmarkCategory = landmark.category || landmark.entityType || null;
    }

    if (!result.city && (district || microdistrict || metro || residentialComplex || street || landmark)) result.city = cityName;
    if (result.district && result.microdistrict && result.metro && result.residentialComplex && result.street && result.landmark && result.city) break;
  }

  if (countryCode === 'UA' && shouldResolveOdesaMetropolitan(text, preferredCity, result.city)) {
    applyOdesaMetropolitan(result, text);
  }

  return result;
}

export function canonicalDictionaryDistrict(name, countryCode) {
  if (!name || !countryCode) return null;
  for (const data of Object.values(mergedCountry(countryCode))) {
    const match = (data.districts || []).find((entry) => entry.re.test(name));
    if (match) return match.name;
  }
  return null;
}

export function dictionaryLocationLists(countryCode) {
  const out = {};
  for (const [city, data] of Object.entries(mergedCountry(countryCode))) {
    const isTashkent = countryCode === 'UZ' && city === 'Tashkent';
    const isOdesa = countryCode === 'UA' && city === 'Odesa';
    const residentialComplexes = isTashkent ? TASHKENT_RESIDENTIAL_COMPLEXES : (data.residentialComplexes || []);
    const landmarks = isTashkent ? TASHKENT_LANDMARKS : (data.landmarks || []);

    out[city] = {
      districts: (data.districts || []).map((x) => x.name),
      metro: (data.metro || []).map((x) => x.name),
      microdistricts: (data.microdistricts || []).map((x) => x.name),
      mahallas: (data.mahallas || []).map((x) => x.name),
      localAreas: (data.localAreas || []).map((x) => x.name),
      suburbs: (data.suburbs || []).map((x) => x.name),
      settlements: (data.settlements || []).map((x) => x.name),
      residentialComplexes: residentialComplexes.map((x) => x.name),
      streets: (data.streets || []).map((x) => x.name),
      landmarks: landmarks.map((x) => x.name),
      ...(isTashkent ? {
        metroLabels: tashkentMetroLabels(),
        poiGroups: Object.fromEntries(Object.entries(TASHKENT_POI_GROUPS).map(([group, entries]) => [group, entries.map((x) => x.name)])),
      } : {}),
      ...(isOdesa ? {
        metropolitanEntities: ODESA_METROPOLITAN_ENTITIES.map((x) => ({ name: x.name, type: x.type, parent: x.parent || null })),
        searchClusters: ODESA_SEARCH_CLUSTERS.map((x) => ({ name: x.name, members: [...x.members] })),
      } : {}),
    };
  }
  return out;
}

export { UA_REGIONS, UA_SECONDARY_CITIES };
