// An hourly price ("4 000 ⃀ / час", "2500 сом за час", "20 USD per hour") is neither a nightly nor a
// monthly price. Such a card stays a short-term stay, the hourly figure is kept as pricePerHour, and the
// price slot is left empty so it cannot be read as a night or a month.
//
// Only a number followed by "/ час", "за час" or "per hour" counts; "в час" and "погодинно" alone are
// too common in ordinary daily/hourly offers to prove the quoted price is per hour.
const CURRENCY_TAIL = String.raw`(?:[⃀₴€$₸]|сом(?:ов)?|сум(?:ов)?|сўм|грн|тг|тенге|руб|usd|eur|uah|kgs|uzs|kzt)?`;
export const HOURLY_PRICE_RE = new RegExp(
  String.raw`\d\s*${CURRENCY_TAIL}\s*(?:\/|за|per)\s*(?:час|hour|hr)(?![\p{L}\p{N}_])`,
  'iu',
);

export function isHourlyPriced(text) {
  return HOURLY_PRICE_RE.test(String(text ?? ''));
}
