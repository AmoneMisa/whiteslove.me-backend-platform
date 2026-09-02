import {
  composeHousingAddress,
  parseHousingAddress,
} from '@whiteslove/parsing-lexicon/housing-address';

function text(value) {
  const out = String(value ?? '').trim();
  return out || null;
}

function parsedCandidate(value) {
  return value?.street ? value : null;
}

function bestParsedAddress(sourceAddress, parsedText) {
  return [parsedCandidate(sourceAddress), parsedCandidate(parsedText)]
    .filter(Boolean)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || null;
}

export function applyStructuredAddressFields(listing) {
  if (!listing || typeof listing !== 'object') return listing;

  const knownStreet = text(listing.street);
  const sourceAddress = text(listing.address)
    ? parseHousingAddress(listing.address, { allowBare: true, knownStreet })
    : null;
  const prose = `${listing.title || ''}\n${listing.description || ''}`.trim();
  const parsedText = prose
    ? parseHousingAddress(prose, { knownStreet })
    : null;
  const bestParsed = bestParsedAddress(sourceAddress, parsedText);

  const street = knownStreet || bestParsed?.street || null;
  const houseNumber = text(listing.houseNumber)
    || bestParsed?.houseNumber
    || null;
  const building = text(listing.building)
    || bestParsed?.building
    || null;

  const canonicalAddress = composeHousingAddress({ street, houseNumber, building });

  listing.street = street;
  listing.houseNumber = houseNumber;
  listing.building = building;
  listing.address = canonicalAddress
    || bestParsed?.address
    || text(listing.address)
    || null;

  return listing;
}

export function applyStructuredAddressFieldsBatch(listings) {
  if (!Array.isArray(listings)) return listings;
  for (const listing of listings) applyStructuredAddressFields(listing);
  return listings;
}
