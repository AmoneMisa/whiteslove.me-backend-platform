// Fills the `places` table for every city the project supports: one Overpass
// pull per city for everyday POIs and metro stations, plus the named
// destinations people mention in listings ("рядом Tashkent City").
//
// Nothing here is city-specific by construction — the bounding box comes from
// Nominatim and stations come from OSM's subway tagging — so adding a city to
// countries.js is enough to enrich it. Only landmarks are curated, because
// "Legion" is not something OSM tags as a category.
//
// Runs on a schedule, not on the request path: a city's shops do not move
// between refreshes.

import { COUNTRIES } from '../countries.js';
import { upsertPlaces } from '../../infrastructure/database/placesRepository.js';
import { TASHKENT_METRO } from '../tashkent-metro.js';

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const UA = 'flat-finder/1.0 (housing aggregator; contact: admin@whiteslove.me)';
const OVERPASS_TIMEOUT_MS = 180_000;
// The public instance grants two slots per IP and frees them roughly every
// half minute. Walking every supported city back to back therefore fails most
// of them unless the sync waits its turn — which it can afford to do, running
// monthly in the background.
const OVERPASS_GAP_MS = Number(process.env.OVERPASS_GAP_MS) || 20_000;
const OVERPASS_RETRIES = 3;
const OVERPASS_RETRY_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Big destinations by name: OSM tags them inconsistently (a business centre, a
// landuse area, an office), so they are resolved by name and kept as landmarks.
const CITY_LANDMARKS = {
  'UZ/Tashkent': [
    'Tashkent City', 'IT Park', 'Legion', 'Magic City', 'Chorsu Bazaar',
    'Alay Bazaar', 'Mega Planet', 'Samarqand Darvoza', 'Compass Mall',
    'Next Mall', 'Amir Timur Square', 'Hazrati Imam Complex', 'Minor Mosque',
    'Tashkent Botanical Garden', 'Japanese Garden Tashkent',
    'Tashkent Railway Station', 'Islam Karimov Tashkent International Airport',
  ],
  'UA/Kyiv': [
    'Maidan Nezalezhnosti', 'Khreshchatyk', 'Gulliver', 'Ocean Plaza',
    'Lavina Mall', 'Respublika Park', 'UNIT.City', 'Kyiv Railway Station',
    'Kyiv Pechersk Lavra', 'Olimpiyskiy Stadium',
  ],
  'KZ/Almaty': [
    'Dostyk Plaza', 'Mega Almaty', 'Esentai Mall', 'Almaty Towers',
    'Green Bazaar', 'Kok Tobe', 'Almaty-2 Railway Station',
  ],
  'KZ/Astana': ['Khan Shatyr', 'Baiterek', 'Mega Silk Way', 'Nur-Sultan Nurly Zhol Railway Station'],
  'RO/Bucharest': [
    'AFI Cotroceni', 'Baneasa Shopping City', 'Unirea Shopping Center',
    'Palace of the Parliament', 'Herastrau Park', 'Gara de Nord',
  ],
};

// Tashkent's stations are curated so their names match the filter dropdown and
// the dictionary; other cities take whatever OSM calls them.
const CURATED_METRO_CITIES = new Set(['UZ/Tashkent']);

// Overpass tag -> our kind. Everything here is something a renter or buyer
// would count as "what is around this flat".
const KIND_RULES = [
  { kind: 'metro', match: (t) => t.station === 'subway' || t.railway === 'subway_entrance' },
  { kind: 'mall', match: (t) => t.shop === 'mall' || t.shop === 'department_store' },
  { kind: 'supermarket', match: (t) => t.shop === 'supermarket' || t.shop === 'convenience' },
  { kind: 'market', match: (t) => t.amenity === 'marketplace' },
  { kind: 'pharmacy', match: (t) => t.amenity === 'pharmacy' },
  { kind: 'clinic', match: (t) => ['hospital', 'clinic', 'doctors'].includes(t.amenity) },
  { kind: 'school', match: (t) => ['school', 'university', 'college'].includes(t.amenity) },
  { kind: 'kindergarten', match: (t) => t.amenity === 'kindergarten' },
  { kind: 'park', match: (t) => ['park', 'garden'].includes(t.leisure) },
  { kind: 'historic', match: (t) => Boolean(t.historic) || ['museum', 'attraction'].includes(t.tourism) },
  { kind: 'cinema', match: (t) => ['cinema', 'theatre'].includes(t.amenity) },
  { kind: 'transport', match: (t) => t.highway === 'bus_stop' || t.railway === 'station' || t.public_transport === 'station' },
];

export function placeCities() {
  // Round-robin across countries rather than country by country. Walking the
  // list in declaration order put Tashkent 37th of 43 — some forty minutes of
  // rate-limited queries after the sync starts — while every capital sat idle
  // behind another country's seventh city. Now each country's main city is
  // done in the first pass.
  const byCountry = Object.entries(COUNTRIES).map(([country, meta]) => ({
    country,
    countryName: meta.name || country,
    cities: [...(meta.cities || [])],
  }));

  const ordered = [];
  const deepest = Math.max(0, ...byCountry.map((entry) => entry.cities.length));

  for (let index = 0; index < deepest; index += 1) {
    for (const entry of byCountry) {
      const city = entry.cities[index];
      if (!city) continue;
      ordered.push({
        country: entry.country,
        city,
        countryName: entry.countryName,
        landmarks: CITY_LANDMARKS[`${entry.country}/${city}`] || [],
      });
    }
  }

  return ordered;
}

function overpassQuery([south, west, north, east]) {
  const box = `(${south},${west},${north},${east})`;
  // Split per category and keep the cap high: a single mixed query hit the
  // 3000-element limit and silently dropped whole categories.
  return `[out:json][timeout:180];
(
  node["station"="subway"]${box};
  node["shop"~"^(supermarket|convenience|mall|department_store)$"]${box};
  way["shop"~"^(supermarket|mall|department_store)$"]${box};
  node["amenity"~"^(marketplace|pharmacy|hospital|clinic|doctors|school|university|college|kindergarten|cinema|theatre)$"]${box};
  way["amenity"~"^(marketplace|hospital|school|university)$"]${box};
  node["leisure"~"^(park|garden)$"]${box};
  way["leisure"~"^(park|garden)$"]${box};
  node["historic"]${box};
  way["historic"]${box};
  node["tourism"~"^(attraction|museum)$"]${box};
  node["railway"="station"]${box};
  node["highway"="bus_stop"]${box};
);
out center tags 12000;`;
}

function elementToRow(element, { country, city }, { skipMetro }) {
  const tags = element.tags || {};
  const name = tags['name:en'] || tags.name || tags['name:ru'] || '';
  if (!name) return null;

  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const rule = KIND_RULES.find((candidate) => candidate.match(tags));
  if (!rule) return null;
  if (rule.kind === 'metro' && skipMetro) return null;

  return {
    country,
    city,
    kind: rule.kind,
    name,
    name_ru: tags['name:ru'] || null,
    lat,
    lng,
    source: 'overpass',
    external_id: `${element.type}/${element.id}`,
    tags: {},
  };
}

async function fetchOverpassOnce(bbox) {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: overpassQuery(bbox) }),
    signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);

  // A throttled or timed-out query answers 200 with an XML error document, so
  // the status code alone does not say whether this worked.
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) {
    throw new Error('overpass busy (non-JSON response)');
  }

  const data = await res.json();
  return Array.isArray(data?.elements) ? data.elements : [];
}

async function fetchOverpass(bbox) {
  let lastError;
  for (let attempt = 1; attempt <= OVERPASS_RETRIES; attempt += 1) {
    try {
      return await fetchOverpassOnce(bbox);
    } catch (error) {
      lastError = error;
      if (attempt < OVERPASS_RETRIES) {
        console.warn(`[places] overpass attempt ${attempt} failed (${error.message}), waiting`);
        await sleep(OVERPASS_RETRY_MS);
      }
    }
  }
  throw lastError;
}

/** Curated landmarks, and Tashkent's canonical stations, through the geocoder. */
async function namedRows(config, lookup) {
  if (typeof lookup !== 'function') return [];
  const rows = [];

  for (const name of config.landmarks) {
    const coords = await lookup(`${name}, ${config.city}, ${config.countryName}`);
    if (!coords) continue;
    rows.push({
      country: config.country,
      city: config.city,
      kind: 'landmark',
      name,
      name_ru: null,
      lat: coords.lat,
      lng: coords.lng,
      source: 'curated',
      external_id: name.toLowerCase().replace(/\s+/g, '-'),
      tags: {},
    });
  }

  if (CURATED_METRO_CITIES.has(`${config.country}/${config.city}`)) {
    for (const station of TASHKENT_METRO) {
      const coords =
        (await lookup(`${station.labels?.en || station.name}, ${config.city}, ${config.countryName}`)) ||
        (station.labels?.ru ? await lookup(`метро ${station.labels.ru} ${config.city}`) : null);
      if (!coords) continue;
      rows.push({
        country: config.country,
        city: config.city,
        kind: 'metro',
        name: station.name,
        name_ru: station.labels?.ru || null,
        lat: coords.lat,
        lng: coords.lng,
        source: 'curated',
        external_id: station.name.toLowerCase().replace(/\s+/g, '-'),
        tags: { line: station.line || null },
      });
    }
  }

  return rows;
}

/** Refills one city. `bboxLookup` resolves the city's extent. */
export async function syncCityPlaces(config, lookup, bboxLookup) {
  const bbox = config.bbox || (await bboxLookup?.(`${config.city}, ${config.countryName}`));
  if (!bbox) {
    console.warn(`[places] ${config.country}/${config.city}: no bounding box, skipped`);
    return { overpass: 0, named: 0, saved: 0 };
  }

  const skipMetro = CURATED_METRO_CITIES.has(`${config.country}/${config.city}`);
  const elements = await fetchOverpass(bbox);
  const overpassRows = elements
    .map((element) => elementToRow(element, config, { skipMetro }))
    .filter(Boolean);

  const named = await namedRows(config, lookup);
  const saved = await upsertPlaces([...overpassRows, ...named]);

  console.log(
    `[places] ${config.country}/${config.city}: ${overpassRows.length} from overpass, ` +
    `${named.length} named, ${saved} saved`,
  );
  return { overpass: overpassRows.length, named: named.length, saved };
}

export async function syncAllPlaces(lookup, bboxLookup) {
  const cities = placeCities();
  const results = [];
  console.log(`[places] syncing ${cities.length} cities`);

  for (const [index, config] of cities.entries()) {
    if (index > 0) await sleep(OVERPASS_GAP_MS);
    try {
      results.push({ city: config.city, ...(await syncCityPlaces(config, lookup, bboxLookup)) });
    } catch (error) {
      console.error(`[places] ${config.city} sync failed:`, error?.message || error);
    }
  }

  const saved = results.reduce((total, row) => total + (row.saved || 0), 0);
  console.log(`[places] sync done: ${results.length}/${cities.length} cities, ${saved} places`);
  return results;
}
