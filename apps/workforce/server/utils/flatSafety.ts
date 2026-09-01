import { parseHousingSafetySignals } from '@whiteslove/parsing-lexicon/housing-safety'

// Linguistic evidence comes from parsing-lexicon; this adapter only applies the
// site's own risk policy on top of it, the same split hiring uses in atsScore.
//
// The pattern being flagged is a room share offered to one specific woman at a
// price far below what a room costs locally — a recurring shape of listing that
// turns out not to be a tenancy at all. Neither half is alarming alone: room
// shares are ordinary, and so are women-only flats. The combination with an
// implausible price is what earns the warning.
const ROOM_SHARE_PRICE_CEILING: Record<string, number> = {
  USD: 120,
  EUR: 110,
  UZS: 1_500_000,
  KZT: 55_000,
  UAH: 4_500,
  RON: 500,
}

function listingText(listing: any): string {
  return [listing?.title, listing?.description, listing?.text, listing?.originalText]
    .filter(Boolean)
    .join('\n')
}

function priceIsImplausiblyLow(listing: any): boolean {
  const ceiling = ROOM_SHARE_PRICE_CEILING[String(listing?.currency || '').toUpperCase()]
  const price = Number(listing?.price)
  if (ceiling == null) return false
  return Number.isFinite(price) && price > 0 && price <= ceiling
}

/**
 * Whether a listing should carry the "potentially unsafe" warning.
 *
 * Upstream wins when it has already made the call, so the flat-finder backend
 * can flag listings this heuristic does not reach.
 */
export function isPotentiallyUnsafeFlat(listing: any): boolean {
  if (listing?.potentiallyUnsafe === true) return true

  const signals = parseHousingSafetySignals(listingText(listing))
  if (!signals.singleFemaleTenantSought) return false

  const roomOnly = listing?.roomOnly === true || signals.roomOnly
  if (!roomOnly) return false

  return priceIsImplausiblyLow(listing)
}
