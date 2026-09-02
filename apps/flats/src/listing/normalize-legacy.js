// A single normalized Listing shape that the Flutter app consumes.
import {createHash} from 'node:crypto';
import {extractTags} from './tags.js';
import { classifyHousingDealType, looksExplicitDailyRentalMention } from '@whiteslove/parsing-lexicon/housing-intent';
import { looksCommercialHousing, looksParkingOnly } from '@whiteslove/parsing-lexicon/housing-commercial';
import { looksHousingRoomOnly } from '@whiteslove/parsing-lexicon/housing';
import { dedupeHousingNearbyMentions } from '@whiteslove/parsing-lexicon/housing-card-fields';
import { parsePrimaryContact } from '@whiteslove/parsing-lexicon/contact';
import { parseHousingAreaFromText } from '@whiteslove/parsing-lexicon/housing-text';
import { parseHousingListingFields } from '@whiteslove/parsing-lexicon/housing-listing-fields';
import {
  parseHousingCardAmenities as parseAmenities,
  parseHousingNearbyMentions as parseNearbyPlaces,
  parseHousingNearbyShops as parseNearbyShops,
  parseHousingQuarterLabel as parseKvartal,
} from '@whiteslove/parsing-lexicon/housing-card-fields';
import {
  classifyAudience, parseCommission, parseExplicitDistrict, parseFloor, parseResidentialComplex,
  parseRoomsFromText,
} from './textparse-overrides.js';
import {canonicalDistrict, parseLocation} from '../geo/locations.js';
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

// Nearby-place dedupe and the "parking space only" / "explicit daily rental"
// signals now live in @whiteslove/parsing-lexicon (housing-card-fields /
// housing-commercial / housing-intent); re-export looksParkingOnly so
// existing consumers of this module keep working unchanged.
const normalizeNearbyPlaces = dedupeHousingNearbyMentions;
export { looksParkingOnly };

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
  const listingFields = parseHousingListingFields(combined, {country});
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
  const parsedDealType = housingIntent?.dealType ?? parseLexiconDealType(combined) ?? classifyHousingDealType(combined);
  const explicitShortStay = parsedDealType === 'shortRent' || looksExplicitDailyRentalMention(combined);

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
  const buildingYear = partial.buildingYear != null ? Number(partial.buildingYear) : listingFields.buildingYear ?? null;
  const bedrooms = partial.bedrooms != null ? Number(partial.bedrooms) : listingFields.bedrooms ?? null;
  const audience = partial.audience ?? classifyAudience(combined);
  const contact = partial.contact ?? parsePrimaryContact(combined);
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
  const commercial = partial.commercial === true || looksCommercialHousing(combined) || looksParkingOnly(combined);
  const petsAllowed = partial.petsAllowed ?? listingFields.petsAllowed ?? null;
  const childrenAllowed = partial.childrenAllowed ?? listingFields.childrenAllowed ?? null;
  const occupancyType = partial.occupancyType ?? parseHousingOccupancyType(combined);
  const roomOnly = partial.roomOnly
    ?? (['room', 'sharedRoom', 'bedSpace'].includes(occupancyType) || looksHousingRoomOnly(combined));

  const structuredDeposit = housingStructured.payments.deposit;
  const depositKind = partial.depositKind
    ?? structuredDeposit.kind
    ?? parseDepositKind(combined);
  const deposit = partial.deposit
    ?? structuredDeposit.required
    ?? (depositKind === 'noDeposit' ? false : listingFields.depositRequired ?? null);
  const depositAmount = partial.depositAmount
    ?? structuredDeposit.amount
    ?? null;
  const depositCurrency = partial.depositCurrency
    ?? structuredDeposit.currency
    ?? null;

  const com = parseCommission(combined);
  const structuredCommission = housingStructured.payments.commission;
  const commission = partial.commission
    ?? structuredCommission.required
    ?? com.has;
  const commissionPercent = partial.commissionPercent
    ?? structuredCommission.percent
    ?? com.percent;

  const balcony = partial.balcony ?? listingFields.balcony ?? null;
  const terrace = partial.terrace ?? parseTerrace(combined);
  const privateYard = partial.privateYard ?? parsePrivateYard(combined);
  const dishwasher = partial.dishwasher ?? parseDishwasher(combined);
  const airConditioner = partial.airConditioner ?? listingFields.airConditioner ?? null;
  const gas = partial.gas ?? listingFields.gas ?? null;
  const bathrooms = partial.bathrooms != null ? Number(partial.bathrooms) : listingFields.bathrooms ?? null;
  const newBuilding = partial.newBuilding
    ?? (listingFields.newBuilding || (buildingYear && buildingYear >= new Date().getFullYear() - 5 ? true : null));
  const communalSeparated = partial.communalSeparated ?? listingFields.communalSeparated ?? null;
  const parsedKvartal = parseKvartal(combined);
  const area = partial.area ?? loc.area ?? partial.kvartal ?? parsedKvartal;
  const kvartal = partial.kvartal ?? area;
  const nearbyShops = partial.nearbyShops ?? parseNearbyShops(combined);
  const amenities = Array.isArray(partial.amenities) ? partial.amenities : parseAmenities(combined);
  const appliances = Array.isArray(partial.appliances) ? partial.appliances : parseAppliances(combined);
  const parking = partial.parking ?? listingFields.parking ?? null;
  const elevator = partial.elevator ?? listingFields.elevator ?? null;
  const heating = partial.heating ?? listingFields.heating ?? null;
  const hotWater = partial.hotWater ?? listingFields.hotWater ?? null;
  const internet = partial.internet ?? listingFields.internet ?? null;
  const smokingAllowed = partial.smokingAllowed ?? listingFields.smokingAllowed ?? null;
  const negotiable = partial.negotiable ?? listingFields.negotiable ?? null;
  const furnished = partial.furnished ?? listingFields.furnished ?? null;
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
    : (housingStructured.area.total ?? parseHousingAreaFromText(combined));
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
