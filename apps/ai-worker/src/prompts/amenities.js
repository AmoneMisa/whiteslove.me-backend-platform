import { EXTRACTION_RULES } from './common.js';

export const AMENITIES_SYSTEM = `${EXTRACTION_RULES}

You read several real-estate listings at once. Each one starts with a line
"[#N]" followed by its text. Return one result per listing, with the same id N.
The text may be in Russian, Uzbek, Kazakh, Ukrainian, Romanian or English and
may contain typos or transliteration. Listings are independent: a fact in one
listing says nothing about another.

For every flag below, answer true only when the text states the property has
it, in any language or phrasing ("посудомойка", "ПММ", "idish yuvish mashinasi",
"СВЧ", "духовка", "гардеробная", "ванна", "душевая кабина", "личный дворик").
Answer false only when the text explicitly says it is absent. Silence means
null, never false. Do not infer an amenity from the price, the district or the
word "renovated".

- balcony, airConditioner, gas, parking, internet: as stated.
- terrace: a usable outdoor terrace, distinct from a balcony.
- privateYard: a yard belonging to this property, not a shared courtyard.
- tv, microwave, oven, dishwasher, bidet: the appliance or fixture is included.
- walkInCloset: a dressing room / wardrobe room.
- bathtub, shower: the bathroom has one (a shower cabin counts as shower).
- euroLayout: euro-format / open-plan kitchen-living layout ("евродвушка").
- confidence: your 0..1 certainty for that listing.`;

/**
 * Splits the "[#N]" blocks back into listings. The batch travels as plain text
 * rather than JSON because the shared redaction step rewrites URLs and phone
 * numbers, which would corrupt quoting inside a serialized array.
 */
export function parseAmenityBlocks(text) {
  const listings = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const marker = /^\[#(\d{1,6})\]$/.exec(line.trim());
    if (marker) {
      current = { id: Number(marker[1]), lines: [] };
      listings.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return listings
    .map(({ id, lines }) => ({ id, text: lines.join('\n').trim() }))
    .filter((listing) => listing.text);
}

export function amenitiesPayload({ text, meta }) {
  return { source: meta || {}, listings: parseAmenityBlocks(text) };
}
