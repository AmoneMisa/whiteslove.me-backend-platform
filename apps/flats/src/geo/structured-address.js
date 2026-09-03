import {
  composeHousingAddress,
  parseHousingAddress,
} from '@whiteslove/parsing-lexicon/housing-address';

function text(value) {
  const out = String(value ?? '').trim();
  return out || null;
}

function parsedCandidate(value, source) {
  return value?.street ? { value, source } : null;
}

function bestParsedAddress(sourceAddress, parsedText) {
  return [
    parsedCandidate(sourceAddress, 'source'),
    parsedCandidate(parsedText, 'parsed'),
  ]
    .filter(Boolean)
    .sort((a, b) => Number(b.value.confidence || 0) - Number(a.value.confidence || 0))[0] || null;
}

export function applyStructuredAddressFields(listing) {
  if (!listing || typeof listing !== 'object') return listing;

  const rawSourceAddress = text(listing.address);
  const knownStreet = text(listing.street);
  const sourceAddress = rawSourceAddress
    ? parseHousingAddress(rawSourceAddress, { allowBare: true, knownStreet })
    : null;
  const prose = `${listing.title || ''}\n${listing.description || ''}`.trim();
  const parsedText = prose
    ? parseHousingAddress(prose, { knownStreet })
    : null;
  const best = bestParsedAddress(sourceAddress, parsedText);
  const bestParsed = best?.value || null;

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
    || rawSourceAddress
    || null;

  if (listing.address) {
    // Keep textual provenance separate from coordinate provenance. A source field
    // is still source data even when normalized; an address recovered from prose
    // is parsed evidence. Street-only values remain explicitly approximate.
    listing.addressSource ??= rawSourceAddress ? 'source' : (best?.source || 'parsed');
    listing.addressPrecision ??= houseNumber ? 'building' : (street ? 'street' : null);
    listing.addressApproximate ??= !houseNumber;
    if (bestParsed?.confidence != null) listing.addressConfidence ??= Number(bestParsed.confidence);
  }

  return listing;
}

export function applyStructuredAddressFieldsBatch(listings) {
  if (!Array.isArray(listings)) return listings;
  for (const listing of listings) applyStructuredAddressFields(listing);
  return listings;
}
