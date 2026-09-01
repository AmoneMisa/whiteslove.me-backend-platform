// A single normalized Listing shape that the Flutter app consumes.
import {createHash} from 'node:crypto';
import {extractTags} from './tags.js';
import {
  classifyChildren, classifyDealType, classifyPets, looksCommercial, looksRoomOnly,
  parseAirConditioner, parseAmenities, parseAreaFromText, parseBalcony, parseBathrooms, parseBedrooms,
  parseCommunalSeparated, parseContact, parseDeposit, parseElevator, parseFurnished, parseGasSupply,
  parseHeating, parseHotWater, parseInternet, parseKvartal, parseNearbyShops, parseNearbyPlaces, parseNegotiable,
  parseNewBuilding, parseParking, parseSmoking, parseYear,
} from './textparse.js';
import {
  classifyAudience, parseCommission, parseExplicitDistrict, parseFloor, parseResidentialComplex,
  parseRoomsFromText,
} from './textparse-overrides.js';
import {canonicalDistrict, parseLocation} from './locations.js';
import {housingSemanticCanonical} from '@whiteslove/parsing-lexicon';
import {parseDishwasher, parsePrivateYard, parseTerrace} from './amenity-parse.js';
import {
  parseAppliances,
  parseCanonicalCity,
  parseCanonicalCountryCode,
  parseCanonicalRegion,
  parseDepositKind,
  parseHousingIntent,
  parseHousingOccupancyType,
  parseHousingSemanticContext,
  parseHousingStructuredContext,
  parseLexiconAddress,
  parseLexiconDealType,
} from './lexicon-parse.js';

function stripHtml(s) {
  return String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#3[49];/g, "'").replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const PARKING_OBJECT_RE = /(?:парко?мест[а-яёіїґ]*|парковочн[а-яёіїґ]*\s+мест[а-яёіїґ]*|машино[-\s]?мест[а-яёіїґ]*|мест[а-яёіїґ]*\s+(?:в|на)\s+(?:паркинг[а-яёіїґ]*|парковк[а-яёіїґ]*)|parking\s+(?:space|spot)s?)/iu;
const HOUSING_OBJECT_RE = /(?:квартир[а-яёіїґ]*|апартамент[а-яёіїґ]*|студи[яії][а-яёіїґ]*|будин[а-яіїґ]*|(?:^|[^\p{L}\p{N}_])дом(?:а|ом|у|ов)?(?=$|[^\p{L}\p{N}_])|жиль[а-яё]*|житл[а-яіїґ]*|flat\b|apartment\b|studio\b|house\b|xonadon\b|kvartira\b|apartament\b|garsonier[ăa]\b)/iu;
const EXPLICIT_SHORT_STAY_RE = /(?:^|[^\p{L}\p{N}_])сут(?:ки|ок)(?=$|[^\p{L}\p{N}_])/iu;

const NEARBY_CATEGORY_ALIASES = [
  ['park', ['park', 'парк']],
  ['school', ['school', 'школа']],
  ['market', ['market', 'рынок', 'ринок', 'базар']],
  ['stadium', ['stadium', 'стадион', 'стадіон']],
  ['clinic', ['clinic', 'клиника', 'клініка']],
];

function normalizeNearbyPlaces(values) {
  const unique = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    // Generic terms (parks, markets, restaurants...) come back from the
    // shared lexicon as an English canonical name; dedupe by that canonical
    // identity so "Park"/"Парк"/"парки" collapse to one entry instead of
    // three near-duplicate chips. The canonical/English form is kept as
    // stored value; the client is responsible for localized display.
    const key = housingSemanticCanonical(value).toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }

  const categoryForExact = (value) => {
    const key = value.toLocaleLowerCase();
    return NEARBY_CATEGORY_ALIASES.find(([, aliases]) => aliases.includes(key))?.[0] || null;
  };
  const hasSpecific = (category) => {
    const aliases = NEARBY_CATEGORY_ALIASES.find(([name]) => name === category)?.[1] || [];
    return unique.some((value) => {
      const key = value.toLocaleLowerCase();
      if (aliases.includes(key)) return false;
      return aliases.some((alias) => key.startsWith(`${alias} `) || key.endsWith(` ${alias}`));
    });
  };

  return unique.filter((value) => {
    const category = categoryForExact(value);
    return !category || !hasSpecific(category);
  });
}

export function looksParkingOnly(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value || !PARKING_OBJECT_RE.test(value)) return false;
  return !HOUSING_OBJECT_RE.test(value);
}

function normalizeListingTitle(value, {propertyType, rooms, residenceComplex, address, city}) {
  const cleaned = stripHtml(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
  const letters = (cleaned.match(/\p{L}/gu) || []).length;
  const meaningful = cleaned && letters >= 3 && cleaned.length <= 90;
  if (meaningful) return cleaned;

  const noun = propertyType === 'house' ? 'Дом' : 'Квартира';
  const base = rooms != null && Number.isFinite(Number(rooms)) && Number(rooms) >= 1 && Number(rooms) <= 10
    ? `${Number(rooms)}-комнатная ${noun.toLowerCase()}`
    : noun;
  const place = residenceComplex || address || city;
  return place ? `${base} · ${place}` : base;
}

// Cheap synchronous guard for the concrete production failure that prompted
// the general asynchronous bbox validator. Bounds are intentionally broad.
const SOURCE_CITY_BOUNDS = {
  'UA:Odesa': [46.25, 30.45, 46.65, 30.88],
};

function sourceCoordinates(partial, city, country) {
  const lat = partial.lat != null ? Number(partial.lat) : null;
  const lng = partial.lng != null ? Number(partial.lng) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {lat: null, lng: null, rejected: false};
  }
  const bounds = SOURCE_CITY_BOUNDS[`${country}:${city}`];
  if (!bounds) return {lat, lng, rejected: false};
  const [south, west, north, east] = bounds;
  const rejected = lat < south || lat > north || lng < west || lng > east;
  return rejected
    ? {lat: null, lng: null, rejected: true}
    : {lat, lng, rejected: false};
}

export function makeListing(partial) {
  const sourceTitle = partial.title ?? '';
  const description = stripHtml(partial.description ?? '');
  const combined = `${sourceTitle} ${description}`;
  const country = parseCanonicalCountryCode(partial.country) || '';
  const propertyType = partial.propertyType === 'house' ? 'house' : 'flat';
  const housingStructured = parseHousingStructuredContext(combined);
  const byAgency = partial.byAgency != null
    ? Boolean(partial.byAgency)
    : housingStructured.seller.type === 'agency';
  const rooms = partial.rooms != null
    ? Number(partial.rooms)
    : (parseRoomsFromText(combined) ?? housingStructured.rooms);
  const housingIntent = housingStructured.intent ?? parseHousingIntent(combined);
  const housingContext = housingStructured.context ?? parseHousingSemanticContext(combined);
  const housingAction = partial.housingAction ?? partial.action ?? housingIntent?.action ?? null;
  const listingKind = partial.listingKind ?? housingIntent?.listingKind ?? 'propertyOffer';
  const parsedDealType = housingIntent?.dealType ?? parseLexiconDealType(combined) ?? classifyDealType(combined);
  const explicitShortStay = parsedDealType === 'shortRent' || EXPLICIT_SHORT_STAY_RE.test(combined);

  // Explicit short-term language outranks a scraper's generic long-rent default.
  // An explicit sale stays authoritative because sale copy can mention rental yield.
  let dealType = partial.dealType === 'sale'
    ? 'sale'
    : explicitShortStay
      ? 'shortRent'
      : (partial.dealType ?? parsedDealType);

  const SALE_FLOOR = {
    USD: 10000,
    EUR: 10000,
    GBP: 10000,
    UYE: 10000,
    UZS: 100_000_000,
    KZT: 5_000_000,
    UAH: 500_000,
    RON: 50_000,
    KGS: 800_000,
    TJS: 90_000,
    RUB: 700_000,
  };
  if (
    partial.dealType == null &&
    dealType !== 'sale' &&
    dealType !== 'shortRent' &&
    partial.price != null
  ) {
    const floor = SALE_FLOOR[String(partial.currency ?? '').toUpperCase()];
    if (floor && Number(partial.price) >= floor) dealType = 'sale';
  }

  const parsedFloor = parseFloor(combined);
  const floor = partial.floor != null
    ? Number(partial.floor)
    : (parsedFloor.floor ?? housingStructured.floor.floor);
  const totalFloors = partial.totalFloors != null
    ? Number(partial.totalFloors)
    : (parsedFloor.totalFloors ?? housingStructured.floor.totalFloors);
  const buildingYear = partial.buildingYear != null ? Number(partial.buildingYear) : parseYear(combined);
  const bedrooms = partial.bedrooms != null ? Number(partial.bedrooms) : parseBedrooms(combined);
  const audience = partial.audience ?? classifyAudience(combined);
  const contact = partial.contact ?? parseContact(combined);
  const sourceCity = parseCanonicalCity(country, partial.city || '');
  const explicitDistrict = parseExplicitDistrict(combined, country);
  const loc = parseLocation(combined, country, sourceCity || null);
  const city = sourceCity || parseCanonicalCity(country, loc.city || '') || (country === 'UZ' && explicitDistrict ? 'Tashkent' : '');
  const coords = sourceCoordinates(partial, city, country);
  const district = canonicalDistrict(
    (coords.rejected ? null : partial.district) ?? explicitDistrict ?? loc.district,
    country,
  );
  const metro = partial.metro ?? loc.metro;
  const nearby = partial.nearby
    ? normalizeNearbyPlaces(partial.nearby)
    : normalizeNearbyPlaces([...(loc.nearby || []), ...parseNearbyPlaces(combined)]);
  const parsedResidenceComplex = parseResidentialComplex(combined);
  const kharkivVorobioviHory = country === 'UA' && city === 'Kharkiv' && /вороб[ьъ]?[её]вы\s+горы/iu.test(combined);
  const preferLocalResidence = country === 'UZ' || /^\d+ Жемчужина$/u.test(parsedResidenceComplex || '') || kharkivVorobioviHory;
  const canonicalLocalResidence = kharkivVorobioviHory ? 'Vorobiovi Hory' : parsedResidenceComplex;
  const residenceComplex = partial.residenceComplex
    ?? (preferLocalResidence ? (canonicalLocalResidence ?? loc.residentialComplex) : (loc.residentialComplex ?? canonicalLocalResidence));
  const street = partial.street ?? loc.street ?? null;
  const address = partial.address ?? parseLexiconAddress(combined, street);
  const commercial = partial.commercial === true || looksCommercial(combined) || looksParkingOnly(combined);
  const petsAllowed = partial.petsAllowed ?? classifyPets(combined);
  const childrenAllowed = partial.childrenAllowed ?? classifyChildren(combined);
  const occupancyType = partial.occupancyType ?? parseHousingOccupancyType(combined);
  const roomOnly = partial.roomOnly
    ?? (['room', 'sharedRoom', 'bedSpace'].includes(occupancyType) || looksRoomOnly(combined));

  const dep = parseDeposit(combined);
  const structuredDeposit = housingStructured.payments.deposit;
  const depositKind = partial.depositKind
    ?? structuredDeposit.kind
    ?? parseDepositKind(combined);
  const deposit = partial.deposit
    ?? structuredDeposit.required
    ?? (depositKind === 'noDeposit' ? false : dep.required);
  const depositAmount = partial.depositAmount
    ?? structuredDeposit.amount
    ?? dep.amount;
  const depositCurrency = partial.depositCurrency
    ?? structuredDeposit.currency
    ?? dep.currency
    ?? null;

  const com = parseCommission(combined);
  const structuredCommission = housingStructured.payments.commission;
  const commission = partial.commission
    ?? structuredCommission.required
    ?? com.has;
  const commissionPercent = partial.commissionPercent
    ?? structuredCommission.percent
    ?? com.percent;

  const balcony = partial.balcony ?? parseBalcony(combined);
  const terrace = partial.terrace ?? parseTerrace(combined);
  const privateYard = partial.privateYard ?? parsePrivateYard(combined);
  const dishwasher = partial.dishwasher ?? parseDishwasher(combined);
  const airConditioner = partial.airConditioner ?? parseAirConditioner(combined);
  const gas = partial.gas ?? parseGasSupply(combined);
  const bathrooms = partial.bathrooms != null ? Number(partial.bathrooms) : parseBathrooms(combined);
  const newBuilding = partial.newBuilding
    ?? (parseNewBuilding(combined) || (buildingYear && buildingYear >= new Date().getFullYear() - 5 ? true : null));
  const communalSeparated = partial.communalSeparated ?? parseCommunalSeparated(combined);
  const parsedKvartal = parseKvartal(combined);
  const area = partial.area ?? loc.area ?? partial.kvartal ?? parsedKvartal;
  const kvartal = partial.kvartal ?? area;
  const nearbyShops = partial.nearbyShops ?? parseNearbyShops(combined);
  const amenities = Array.isArray(partial.amenities) ? partial.amenities : parseAmenities(combined);
  const appliances = Array.isArray(partial.appliances) ? partial.appliances : parseAppliances(combined);
  const parking = partial.parking ?? parseParking(combined);
  const elevator = partial.elevator ?? parseElevator(combined);
  const heating = partial.heating ?? parseHeating(combined);
  const hotWater = partial.hotWater ?? parseHotWater(combined);
  const internet = partial.internet ?? parseInternet(combined);
  const smokingAllowed = partial.smokingAllowed ?? parseSmoking(combined);
  const negotiable = partial.negotiable ?? parseNegotiable(combined);
  const furnished = partial.furnished ?? parseFurnished(combined);
  const title = normalizeListingTitle(sourceTitle, {
    propertyType,
    rooms,
    residenceComplex,
    address,
    city,
  });
  const price = partial.price != null ? Number(partial.price) : null;
  const currency = partial.currency ?? '';
  const areaSqm = partial.areaSqm != null
    ? Number(partial.areaSqm)
    : (housingStructured.area.total ?? parseAreaFromText(combined));
  const photoFingerprints = [...new Set(
    (Array.isArray(partial.photoFingerprints) ? partial.photoFingerprints : [])
      .map((value) => String(value || '').toLowerCase())
      .filter((value) => /^[a-f0-9]{64}$/.test(value)),
  )].sort();

  let photoFingerprintKey = partial.photoFingerprintKey ?? null;
  if (!photoFingerprintKey && partial.source === 'telegram') {
    if (photoFingerprints.length >= 2) {
      photoFingerprintKey = photoFingerprints.join('|');
    } else if (photoFingerprints.length === 1 && price != null) {
      const structured = JSON.stringify([
        country,
        String(city || '').toLowerCase(),
        dealType || '',
        propertyType,
        price,
        String(currency || '').toUpperCase(),
        rooms ?? null,
        areaSqm ?? null,
        String(title || '').toLowerCase(),
      ]);
      const structuredHash = createHash('sha256').update(structured).digest('hex');
      photoFingerprintKey = `${photoFingerprints[0]}|${structuredHash}`;
    }
  }

  return {
    id: String(partial.id),
    source: partial.source,
    country,
    title,
    propertyType,
    byAgency,
    price,
    currency,
    rooms,
    areaSqm,
    areaDetails: partial.areaDetails ?? housingStructured.area,
    city,
    region: parseCanonicalRegion(country, partial.region ?? loc.region) ?? null,
    locality: partial.locality ?? loc.locality ?? null,
    localAreas: Array.isArray(partial.localAreas) ? partial.localAreas : [...(loc.localAreas || [])],
    suburbs: Array.isArray(partial.suburbs) ? partial.suburbs : [...(loc.suburbs || [])],
    informalAreas: Array.isArray(partial.informalAreas) ? partial.informalAreas : [...(loc.informalAreas || [])],
    developmentAreas: Array.isArray(partial.developmentAreas) ? partial.developmentAreas : [...(loc.developmentAreas || [])],
    searchClusters: Array.isArray(partial.searchClusters) ? partial.searchClusters : [...(loc.searchClusters || [])],
    locationEntities: Array.isArray(partial.locationEntities) ? partial.locationEntities : [...(loc.locationEntities || [])],
    microdistrict: coords.rejected ? null : (partial.microdistrict ?? loc.microdistrict ?? null),
    street,
    address: address || null,
    lat: coords.lat,
    lng: coords.lng,
    sourceCoordinateRejected: coords.rejected || partial.sourceCoordinateRejected === true,
    photo: partial.photo ?? (Array.isArray(partial.photos) ? partial.photos[0] : null) ?? null,
    photos: Array.isArray(partial.photos) ? partial.photos : (partial.photo ? [partial.photo] : []),
    photoFingerprints,
    photoFingerprintKey,
    url: partial.url ?? '',
    createdAt: partial.createdAt ?? null,
    description,
    housingAction,
    listingKind,
    dealType,
    occupancyType,
    floor,
    totalFloors,
    buildingYear,
    bedrooms,
    audience,
    contact,
    district,
    area,
    areaAmbiguous: partial.areaAmbiguous ?? loc.areaAmbiguous ?? false,
    locationConfidence: partial.locationConfidence ?? loc.locationConfidence ?? null,
    requireExactAddress: partial.requireExactAddress ?? loc.requireExactAddress ?? false,
    metro,
    nearby,
    residenceComplex,
    commercial,
    petsAllowed,
    childrenAllowed,
    roomOnly,
    deposit,
    depositKind,
    depositAmount,
    depositCurrency,
    commission,
    commissionPercent,
    paymentContext: partial.paymentContext ?? housingStructured.payments,
    sellerType: partial.sellerType ?? housingStructured.seller.type ?? (byAgency ? 'agency' : null),
    sellerConfidence: partial.sellerConfidence ?? housingStructured.seller.confidence,
    infrastructure: Array.isArray(partial.infrastructure) ? partial.infrastructure : [...housingStructured.infrastructure],
    balcony,
    terrace,
    privateYard,
    dishwasher,
    airConditioner,
    gas,
    bathrooms,
    newBuilding,
    communalSeparated,
    kvartal,
    nearbyShops,
    parking,
    elevator,
    heating,
    hotWater,
    internet,
    smokingAllowed,
    negotiable,
    furnished,
    furnitureState: partial.furnitureState ?? housingContext.furniture ?? null,
    condition: partial.condition ?? housingContext.condition ?? null,
    propertyCondition: partial.propertyCondition ?? housingContext.condition ?? null,
    layoutTypes: Array.isArray(partial.layoutTypes) ? partial.layoutTypes : [...housingContext.layouts],
    buildingType: partial.buildingType ?? housingContext.buildingType ?? null,
    buildingStatus: partial.buildingStatus ?? housingContext.buildingStatus ?? null,
    priceContext: partial.priceContext ?? housingContext.priceContext ?? null,
    priceModifiers: Array.isArray(partial.priceModifiers) ? partial.priceModifiers : [...housingContext.priceModifiers],
    rentDuration: partial.rentDuration ?? housingContext.rentDuration ?? null,
    floorConstraints: Array.isArray(partial.floorConstraints) ? partial.floorConstraints : [...housingContext.floorConstraints],
    tenantPolicies: partial.tenantPolicies ?? housingContext.tenantPolicies,
    documentStatus: Array.isArray(partial.documentStatus) ? partial.documentStatus : [...housingContext.documents],
    financing: Array.isArray(partial.financing) ? partial.financing : [...housingContext.financing],
    locationRelations: Array.isArray(partial.locationRelations) ? partial.locationRelations : [...housingContext.locationRelations],
    availability: partial.availability ?? housingContext.availability ?? null,
    listingStatus: partial.listingStatus ?? housingContext.listingStatus ?? 'active',
    amenities,
    appliances,
    tags: partial.tags ?? extractTags({
      title,
      description,
      propertyType,
      byAgency,
      rooms,
      dealType,
      audience,
      district,
      nearby,
      residenceComplex,
      petsAllowed,
      childrenAllowed,
      roomOnly,
      deposit,
      commission,
      commissionPercent,
    }),
  };
}
