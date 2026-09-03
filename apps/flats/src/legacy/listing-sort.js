import { toUsd } from '../support/fx.js';

function timestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareNullableNumber(a, b, direction) {
  const aMissing = a == null || !Number.isFinite(a);
  const bMissing = b == null || !Number.isFinite(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return direction * (a - b);
}

function compareDate(a, b, oldestFirst = false) {
  return compareNullableNumber(
    timestamp(a.createdAt),
    timestamp(b.createdAt),
    oldestFirst ? 1 : -1,
  );
}

function comparePrice(a, b, rates, ascending) {
  const primary = compareNullableNumber(
    toUsd(a.price, a.currency, rates),
    toUsd(b.price, b.currency, rates),
    ascending ? 1 : -1,
  );
  return primary || compareDate(a, b, false);
}

export function sortListings(listings, sort, rates = null) {
  if (!Array.isArray(listings)) return listings;

  switch (sort) {
    case 'oldest':
      listings.sort((a, b) => compareDate(a, b, true));
      break;
    case 'priceAsc':
      listings.sort((a, b) => comparePrice(a, b, rates, true));
      break;
    case 'priceDesc':
      listings.sort((a, b) => comparePrice(a, b, rates, false));
      break;
    case 'newest':
    default:
      listings.sort((a, b) => compareDate(a, b, false));
      break;
  }

  return listings;
}
