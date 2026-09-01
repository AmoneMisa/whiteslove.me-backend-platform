// Deterministic demo data for local development and tests only.
// Production must report degraded/unavailable sources instead of presenting
// realistic synthetic listings as if they came from a live marketplace.

import { COUNTRIES } from './countries.js';
import { makeListing } from './normalize.js';
import { cityLocations } from './locations.js';

const FEATURES = [
  'furnished, renovated, with balcony',
  'unfurnished, parking included, elevator',
  'new build, central heating, pets ok',
  'renovated studio, utilities included',
  'from owner, no agency, negotiable price',
  'for rent, furnished, balcony and parking',
];

// Roughly a third of demo listings are for sale, then long-term rent, then
// short-term rent, so every deal-type filter has something to show.
const DEAL_TYPES = ['sale', 'longRent', 'shortRent'];
const DEAL_WORDS = { sale: 'for sale', longRent: 'for rent', shortRent: 'short-term / daily rent' };

// Roughly a quarter of demo listings state a tenant restriction so the
// audience filter (women / men / family) always has something to show.
const AUDIENCES = [null, null, null, 'family', 'women', 'men'];
const AUDIENCE_WORDS = { family: 'for a family', women: 'for girls only', men: 'for men only' };

const SAMPLE_CITIES = {
  RO: ['Bucharest', 'Cluj-Napoca', 'Timisoara', 'Iasi', 'Brasov'],
  UA: ['Kyiv', 'Lviv', 'Odesa', 'Kharkiv', 'Dnipro'],
  KZ: ['Almaty', 'Astana', 'Shymkent', 'Karaganda', 'Aktobe'],
  UZ: ['Tashkent', 'Samarkand', 'Bukhara', 'Namangan', 'Andijan'],
};

// Rough price scale per currency so the numbers look believable.
const PRICE_BASE = {
  RON: 85000,
  UAH: 1800000,
  KZT: 22000000,
  UZS: 550000000,
};

function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function generateMock(countryCode, count = 30) {
  if (process.env.NODE_ENV === 'production') return [];

  const c = COUNTRIES[countryCode];
  if (!c) return [];
  const rand = rng(countryCode.split('').reduce((a, ch) => a + ch.charCodeAt(0), 7));
  const cities = SAMPLE_CITIES[countryCode] ?? [c.name];
  const base = PRICE_BASE[c.currency] ?? 100000;
  const out = [];
  for (let i = 0; i < count; i++) {
    const isHouse = rand() > 0.6;
    const byAgency = rand() > 0.5;
    const rooms = 1 + Math.floor(rand() * (isHouse ? 6 : 4));
    const area = isHouse ? 70 + Math.floor(rand() * 180) : 28 + Math.floor(rand() * 90);
    const dealType = DEAL_TYPES[Math.floor(rand() * DEAL_TYPES.length)];
    // Rent listings are priced per month, so scale them well below sale prices.
    const rentMul = dealType === 'shortRent' ? 0.01 : dealType === 'longRent' ? 0.004 : 1;
    const priceMul = (0.5 + rand() * 2.2 + (isHouse ? 0.8 : 0)) * rentMul;
    const features = FEATURES[Math.floor(rand() * FEATURES.length)];
    // Houses are low-rise (1-3 floors); flats sit in taller blocks.
    const totalFloors = isHouse ? 1 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 13);
    const floor = 1 + Math.floor(rand() * totalFloors);
    const bedrooms = Math.max(1, rooms - 1);
    const buildingYear = 1970 + Math.floor(rand() * 55);
    const audience = AUDIENCES[Math.floor(rand() * AUDIENCES.length)];
    const contact = `+${['40', '380', '7', '998'][['RO', 'UA', 'KZ', 'UZ'].indexOf(countryCode)] ?? '1'}${Math.floor(rand() * 900000000 + 100000000)}`;
    const audiencePhrase = audience ? ` ${AUDIENCE_WORDS[audience]}.` : '';

    // Attach intra-city location data when we have it for the picked city.
    const cityName = cities[Math.floor(rand() * cities.length)];
    const cityLoc = cityLocations(countryCode)?.[cityName];
    const pick = (arr) => (arr && arr.length ? arr[Math.floor(rand() * arr.length)] : null);
    const district = pick(cityLoc?.districts);
    const metro = pick(cityLoc?.metro);
    const nearby =
      cityLoc?.landmarks && rand() > 0.5 ? [pick(cityLoc.landmarks)].filter(Boolean) : [];
    const locPhrase = [
      district ? `${district} district` : '',
      metro ? `near ${metro} metro` : '',
      nearby.length ? `close to ${nearby[0]}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    out.push(
      makeListing({
        id: `${countryCode}-mock-${i}`,
        source: 'mock',
        country: countryCode,
        title: `${isHouse ? 'House' : 'Apartment'} ${rooms} rooms, ${area} m² — ${DEAL_WORDS[dealType]}`,
        description:
          `${isHouse ? 'House' : 'Apartment'} in ${cityName}, ${DEAL_WORDS[dealType]}. ` +
          `Floor ${floor}/${totalFloors}, ${bedrooms} bedrooms, built in ${buildingYear}. ` +
          `${locPhrase ? `${locPhrase}. ` : ''}${features}.${audiencePhrase}`,
        propertyType: isHouse ? 'house' : 'flat',
        dealType,
        byAgency,
        price: Math.max(1000, Math.round((base * priceMul) / 1000) * 1000),
        currency: c.currency,
        rooms,
        areaSqm: area,
        floor,
        totalFloors,
        bedrooms,
        buildingYear,
        audience,
        contact,
        district,
        metro,
        nearby,
        city: cityName,
        lat: c.center.lat + (rand() - 0.5) * 0.35,
        lng: c.center.lng + (rand() - 0.5) * 0.35,
        photo: `https://picsum.photos/seed/${countryCode}${i}/600/400`,
        url: c.olxHost ?? '',
        createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
      }),
    );
  }
  return out;
}
