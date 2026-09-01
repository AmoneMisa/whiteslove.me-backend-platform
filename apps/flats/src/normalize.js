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

export function makeListing(partial) {
  const listing = makeLegacyListing(partial);
  const text = `${partial?.title ?? ''}\n${partial?.description ?? ''}`;
  const country = String(partial?.country || listing.country || '').toUpperCase();
  const fields = parseHousingListingFields(text, { country });
  const parsedPrice = parseHousingPrice(text, partial?.currency || listing.currency || '');

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
    address,
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
