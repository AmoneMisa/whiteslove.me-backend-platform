// Compatibility facade around the historical normalizer. Shared free-text
// housing semantics are resolved by @whiteslove/parsing-lexicon first.
import { parseHousingListingFields } from '@whiteslove/parsing-lexicon';
import { parseHousingPrice } from '@whiteslove/parsing-lexicon/housing-money';
import { makeListing as makeLegacyListing } from './normalize-legacy.js';

export * from './normalize-legacy.js';

const CITY_CENTRE_ADDRESS_RE = /^(?:центр|центр\s+міста|центр\s+города|centre|center)(?:\s+\d+\s*\/\s*\d+)?$/iu;
const UA_EXPLICIT_STREET_RE = /(?:^|[\s,;])((?:вул(?:иця)?\.?)\s*[\p{L}'’.-]{2,48})(?=$|[\s,;])/ium;
const LEGACY_FURNITURE_RE = /(?:^|[^\p{L}\p{N}_])(?:shkof|шкаф|gilam|гилам|mebel|мебел\p{L}*)(?=$|[^\p{L}\p{N}_])/iu;

function consumerAddress(address, text, country) {
  const value = String(address || '').trim();
  if (value && CITY_CENTRE_ADDRESS_RE.test(value)) return null;
  if (value || country !== 'UA') return address || null;
  return text.match(UA_EXPLICIT_STREET_RE)?.[1]?.trim() || null;
}

function normalizePhotoValue(value) {
  let raw = value;
  if (value && typeof value === 'object') {
    raw = value.link ?? value.url ?? value.src ?? value.imageUrl ?? null;
  }
  if (typeof raw !== 'string') return null;
  const photo = raw.trim();
  if (!photo) return null;
  return photo
    .replaceAll('{width}', '800')
    .replaceAll('{height}', '600');
}

function normalizeListingPhotos(partial, listing) {
  const candidates = Array.isArray(partial?.photos)
    ? partial.photos
    : (Array.isArray(listing?.photos) ? listing.photos : []);
  const photos = [...new Set(candidates.map(normalizePhotoValue).filter(Boolean))];
  const single = normalizePhotoValue(partial?.photo) ?? normalizePhotoValue(listing?.photo);

  if (single && !photos.includes(single)) photos.unshift(single);

  return {
    photo: photos[0] ?? single ?? null,
    photos: photos.length ? photos : (single ? [single] : []),
  };
}

function sourceCoordinateMetadata(partial, listing) {
  const hasCoordinates = listing?.lat != null
    && listing?.lng != null
    && Number.isFinite(Number(listing.lat))
    && Number.isFinite(Number(listing.lng));
  if (!hasCoordinates) {
    return {
      locationSource: partial?.locationSource ?? listing?.locationSource ?? null,
      locationProvider: partial?.locationProvider ?? listing?.locationProvider ?? null,
      locationPrecision: partial?.locationPrecision ?? listing?.locationPrecision ?? null,
      locationAccuracyM: partial?.locationAccuracyM ?? listing?.locationAccuracyM ?? null,
      locationApproximate: partial?.locationApproximate ?? listing?.locationApproximate ?? null,
    };
  }

  // A marketplace/JSON-LD point is real source evidence, but unless that source
  // explicitly declares its precision it is not assumed to be the surveyed
  // building entrance. This lets the persistent resolver upgrade it with a
  // proved street+house, canonical complex, primary POI/metro or other stronger
  // evidence without discarding its original coordinate from the audit trail.
  return {
    locationSource: partial?.locationSource ?? listing?.locationSource ?? 'sourceCoordinates',
    locationProvider: partial?.locationProvider ?? listing?.locationProvider ?? partial?.source ?? null,
    locationPrecision: partial?.locationPrecision ?? listing?.locationPrecision ?? 'broad',
    locationAccuracyM: partial?.locationAccuracyM ?? listing?.locationAccuracyM ?? null,
    locationApproximate: partial?.locationApproximate ?? listing?.locationApproximate ?? true,
  };
}

export function makeListing(partial) {
  const listing = makeLegacyListing(partial);
  const text = `${partial?.title ?? ''}\n${partial?.description ?? ''}`;
  const country = String(partial?.country || listing.country || '').toUpperCase();
  const fields = parseHousingListingFields(text, { country });
  const parsedPrice = parseHousingPrice(text, partial?.currency || listing.currency || '');
  const normalizedPhotos = normalizeListingPhotos(partial, listing);
  const coordinateMetadata = sourceCoordinateMetadata(partial, listing);

  const amenities = [...new Set([
    ...(Array.isArray(listing.amenities) ? listing.amenities : []),
    ...(fields.courtyard ? ['courtyard'] : []),
    ...(fields.gazebo ? ['gazebo'] : []),
  ])];

  const choose = (key) => partial?.[key] ?? fields[key] ?? listing[key];
  const address = consumerAddress(partial?.address ?? listing.address, text, country);
  const furnished = partial?.furnished
    ?? fields.furnished
    ?? listing.furnished
    ?? (LEGACY_FURNITURE_RE.test(text) ? true : null);
  const minLeaseTerm = partial?.minLeaseTerm
    ?? partial?.minRentTerm
    ?? fields.minLeaseTerm
    ?? fields.minRentTerm
    ?? listing.minLeaseTerm
    ?? listing.minRentTerm
    ?? null;

  return {
    ...listing,
    ...coordinateMetadata,
    address,
    photo: normalizedPhotos.photo,
    photos: normalizedPhotos.photos,
    price: partial?.price != null ? listing.price : (parsedPrice.amount ?? listing.price),
    currency: partial?.price != null && partial?.currency
      ? listing.currency
      : (parsedPrice.currency || listing.currency),
    bedrooms: choose('bedrooms'),
    bathrooms: choose('bathrooms'),
    buildingYear: choose('buildingYear'),
    balcony: choose('balcony'),
    terrace: choose('terrace'),
    privateYard: choose('privateYard'),
    dishwasher: choose('dishwasher'),
    airConditioner: choose('airConditioner'),
    tv: choose('tv'),
    microwave: choose('microwave'),
    oven: choose('oven'),
    bidet: choose('bidet'),
    walkInCloset: choose('walkInCloset'),
    bathtub: choose('bathtub'),
    shower: choose('shower'),
    euroLayout: choose('euroLayout'),
    gas: choose('gas'),
    newBuilding: choose('newBuilding'),
    communalSeparated: choose('communalSeparated'),
    parking: choose('parking'),
    elevator: choose('elevator'),
    heating: choose('heating'),
    hotWater: choose('hotWater'),
    internet: choose('internet'),
    petsAllowed: choose('petsAllowed'),
    childrenAllowed: choose('childrenAllowed'),
    smokingAllowed: choose('smokingAllowed'),
    negotiable: choose('negotiable'),
    furnished,
    deposit: partial?.deposit ?? fields.depositRequired ?? listing.deposit ?? null,
    firstRent: partial?.firstRent ?? fields.firstRent ?? listing.firstRent ?? null,
    firstRental: partial?.firstRental ?? fields.firstRent ?? listing.firstRental ?? listing.firstRent ?? null,
    minLeaseTerm,
    // Temporary compatibility alias for older consumers. New clients should
    // use minLeaseTerm, matching the public web/Flutter contract.
    minRentTerm: minLeaseTerm,
    availableFrom: partial?.availableFrom ?? fields.availableFrom ?? listing.availableFrom ?? null,
    utilitiesAmount: partial?.utilitiesAmount ?? fields.utilitiesAmount ?? listing.utilitiesAmount ?? null,
    amenities,
  };
}
