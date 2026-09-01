import {
  isRoomOnlyHousing,
  resolveExtendedHousingIntent,
} from '@whiteslove/parsing-lexicon/housing-source-aliases'

export type FlatDealType = 'sale' | 'longRent' | 'shortRent'

const SOCIAL_SOURCES = new Set(['telegram', 'facebook', 'threads'])

function normalizedText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function listingText(listing: any): string {
  const tags = Array.isArray(listing?.tags) ? listing.tags.join(' ') : ''
  return normalizedText([
    listing?.title,
    listing?.description,
    listing?.text,
    listing?.originalText,
    listing?.priceText,
    listing?.url,
    listing?.id,
    tags,
  ].filter(Boolean).join(' '))
}

function explicitDealFromText(text: string): FlatDealType | null {
  const resolved = resolveExtendedHousingIntent(text)
  return resolved?.dealType || null
}

export function normalizeFlatRoomOnly(listing: any): boolean {
  if (listing?.roomOnly === true) return true
  const text = listingText(listing)
  if (isRoomOnlyHousing(text)) return true

  // Price is only a fallback when the source gave us no deal information.
  if (normalizedText(listing?.dealType) || explicitDealFromText(text)) return false
  return priceBand(listing) === 'room'
}

function explicitDollarAmounts(value: unknown): number[] {
  const text = String(value || '')
  const amounts: number[] = []
  // The negative lookbehind is important for floor notation such as
  // "3/4/5 500$": matching must start at 500, never at the preceding floor 5.
  for (const match of text.matchAll(/(?<![\d/])(\d{2,6}(?:[\s.,]\d{3})?)\s*(?:\$|usd|у\.?\s*е\.?)/giu)) {
    const amount = Number(String(match[1]).replace(/\D/g, ''))
    if (Number.isFinite(amount) && amount > 0) amounts.push(amount)
  }
  return amounts
}

export function normalizeFlatPrice(listing: any): { price: number | null; currency: string } {
  const existingPrice = normalizedPrice(listing?.price)
  const existingCurrency = String(listing?.currency || '').toUpperCase()
  const source = normalizedText(listing?.source)
  const title = String(listing?.title || '').trim()

  if (SOCIAL_SOURCES.has(source)) {
    const titleDollarAmount = explicitDollarAmounts(title).at(-1)
    if (titleDollarAmount != null) return { price: titleDollarAmount, currency: 'USD' }

    const descriptionDollarAmounts = explicitDollarAmounts(listing?.description || listing?.text || listing?.originalText)
    if (existingPrice == null && descriptionDollarAmounts.length) {
      return { price: descriptionDollarAmounts.at(-1)!, currency: 'USD' }
    }
  }

  if (existingPrice != null && existingPrice > 0) {
    return { price: existingPrice, currency: existingCurrency }
  }

  if (!SOCIAL_SOURCES.has(source) || /(?:ming|минг|тыс|million|миллион|млн|sum|сум|uzs)/iu.test(title)) {
    return { price: null, currency: existingCurrency }
  }

  // Compact Telegram posts often put a dollar rent directly after the district
  // (for example, "Шайхонтохур 500") while leaving the structured price empty.
  const trailingAmount = title.match(/(?:^|\s)(\d{2,4})(?:\s*(?:usd|у\.?\s*е\.?|\$))?\s*$/iu)
  const inferredPrice = trailingAmount ? Number(trailingAmount[1]) : null
  if (inferredPrice == null || inferredPrice < 100 || inferredPrice > 5_000) {
    return { price: null, currency: existingCurrency }
  }

  return { price: inferredPrice, currency: 'USD' }
}

function normalizedPrice(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Number(raw.replace(/[^\d.,-]/g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

function priceBand(listing: any): 'room' | 'rent' | 'sale' | null {
  const price = normalizedPrice(listing?.price)
  if (price == null || price <= 0) return null

  const currency = String(listing?.currency || '').toUpperCase()
  const thresholds: Record<string, { roomMax: number; saleMin: number }> = {
    USD: { roomMax: 250, saleMin: 15_000 },
    EUR: { roomMax: 250, saleMin: 15_000 },
    UZS: { roomMax: 2_000_000, saleMin: 100_000_000 },
    UAH: { roomMax: 8_000, saleMin: 300_000 },
    KZT: { roomMax: 120_000, saleMin: 12_000_000 },
    KGS: { roomMax: 20_000, saleMin: 4_000_000 },
    RON: { roomMax: 1_000, saleMin: 100_000 },
  }
  const threshold = thresholds[currency]
  if (!threshold) return null
  if (price <= threshold.roomMax) return 'room'
  if (price >= threshold.saleMin) return 'sale'
  return 'rent'
}

/**
 * Normalizes upstream aliases and restores the deal type omitted by some
 * persisted social listings. Explicit upstream values always win.
 */
export function normalizeFlatDealType(listing: any): FlatDealType | null {
  const raw = normalizedText(listing?.dealType).replace(/\s/g, '')
  if (['sale', 'sell', 'forsale'].includes(raw)) return 'sale'
  if (['longrent', 'rent', 'monthly', 'monthlyrent'].includes(raw)) return 'longRent'
  if (['shortrent', 'daily', 'dailyrent'].includes(raw)) return 'shortRent'

  const text = listingText(listing)
  const explicitDeal = explicitDealFromText(text)
  if (explicitDeal) return explicitDeal
  if (normalizeFlatRoomOnly(listing)) return 'longRent'

  const inferredBand = priceBand(listing)
  if (inferredBand === 'sale') return 'sale'
  if (inferredBand === 'room' || inferredBand === 'rent') return 'longRent'

  return null
}
