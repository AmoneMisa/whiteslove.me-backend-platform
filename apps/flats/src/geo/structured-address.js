import {
  composeHousingAddress,
  parseHousingAddress,
} from '@whiteslove/parsing-lexicon/housing-address';

const WEAK_LEGACY_ADDRESS_NOISE_RE = /(?:^|[^\p{L}\p{N}_])(?:продаж\p{L}*|продаж[аи]?|оренд\p{L}*|аренд\p{L}*|квартир\p{L}*|апартамент\p{L}*|жк|ж\.к\.|жил(?:ой|ого)?\s+комплекс\p{L}*|житлов(?:ий|ого)?\s+комплекс\p{L}*)(?=$|[^\p{L}\p{N}_])/iu;

function text(value) {
  const out = String(value ?? '').trim();
  return out || null;
}

function normalized(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function parsedCandidate(value, source) {
  return value?.street ? { value, source } : null;
}

function sameAddressParts(a, b) {
  if (!a?.street || !b?.street) return false;
  return normalized(a.street) === normalized(b.street)
    && normalized(a.houseNumber) === normalized(b.houseNumber)
    && normalized(a.building) === normalized(b.building);
}

function weakMalformedLegacyAddress(value) {
  if (!value?.street) return false;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence > 0.6) return false;
  return WEAK_LEGACY_ADDRESS_NOISE_RE.test(`${value.address || ''} ${value.street || ''}`);
}

function streetRole(listing, street) {
  const key = normalized(street);
  if (!key) return 'mentioned';
  const entity = (listing.locationEntities || []).find((item) =>
    String(item?.type || '').toLocaleLowerCase() === 'street'
      && normalized(item?.name) === key,
  );
  return entity?.role === 'nearby' || entity?.role === 'primary'
    ? entity.role
    : 'mentioned';
}

function sourceKind(listing, sourceAddress, parsedText) {
  if (listing.addressSource) return listing.addressSource;
  // makeListing can already contain an address extracted from the same prose.
  // When both parsers resolve the same components, retain parsed provenance
  // instead of accidentally upgrading it to a source-provided address.
  if (sameAddressParts(sourceAddress, parsedText)) return 'parsed';
  if (weakMalformedLegacyAddress(sourceAddress)) return null;
  return sourceAddress?.street ? 'source' : null;
}

function bestParsedAddress(sourceAddress, parsedText, source) {
  // A field explicitly marked as source remains authoritative. Otherwise a
  // low-confidence legacy value containing listing prose ("продаж квартири ЖК")
  // is not an address merely because allowBare could split it into street text.
  const sourceCandidate = source === 'source' || !weakMalformedLegacyAddress(sourceAddress)
    ? parsedCandidate(sourceAddress, source || 'source')
    : null;
  return sourceCandidate
    || parsedCandidate(parsedText, 'parsed')
    || null;
}

export function applyStructuredAddressFields(listing) {
  if (!listing || typeof listing !== 'object') return listing;

  const rawSourceAddress = text(listing.address);
  const knownStreet = text(listing.street);
  const explicitHouseNumber = text(listing.houseNumber);
  const sourceAddress = rawSourceAddress
    ? parseHousingAddress(rawSourceAddress, { allowBare: true, knownStreet })
    : null;
  const weakLegacySource = listing.addressSource !== 'source' && weakMalformedLegacyAddress(sourceAddress);
  const prose = `${listing.title || ''}\n${listing.description || ''}`.trim();
  const parsedText = prose
    ? parseHousingAddress(prose, { knownStreet })
    : null;
  const provenance = sourceKind(listing, sourceAddress, parsedText);
  const best = bestParsedAddress(sourceAddress, parsedText, provenance);
  const bestParsed = best?.value || null;

  // A prose-derived street/house under a contextual `nearby` street entity is a
  // reference point, not the property's postal address. Keep the street entity
  // available for geo-role scoring, but do not turn its house number into an
  // exact apartment coordinate. Explicit upstream house fields still win.
  if (best?.source === 'parsed'
    && !explicitHouseNumber
    && streetRole(listing, bestParsed?.street) === 'nearby') {
    listing.street = knownStreet || bestParsed?.street || null;
    listing.houseNumber = null;
    listing.building = null;
    listing.address = null;
    listing.addressSource = 'parsedNearby';
    listing.addressPrecision = null;
    listing.addressApproximate = true;
    if (bestParsed?.confidence != null) listing.addressConfidence = Number(bestParsed.confidence);
    return listing;
  }

  const street = knownStreet || bestParsed?.street || null;
  const houseNumber = explicitHouseNumber
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
    || (!weakLegacySource ? rawSourceAddress : null)
    || null;

  if (listing.address) {
    listing.addressSource ??= best?.source || (rawSourceAddress && !weakLegacySource ? 'source' : null);
    listing.addressPrecision ??= houseNumber ? 'building' : (street ? 'street' : null);
    listing.addressApproximate ??= !houseNumber;
    if (bestParsed?.confidence != null) listing.addressConfidence ??= Number(bestParsed.confidence);
  } else if (weakLegacySource) {
    listing.addressSource = null;
    listing.addressPrecision = null;
    listing.addressApproximate = true;
  }

  return listing;
}

export function applyStructuredAddressFieldsBatch(listings) {
  if (!Array.isArray(listings)) return listings;
  for (const listing of listings) applyStructuredAddressFields(listing);
  return listings;
}
