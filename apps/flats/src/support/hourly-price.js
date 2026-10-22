// An hourly price ("4 000 ⃀ / час", "2500 сом за час", "20 USD per hour") is neither a nightly nor a
// monthly price. Such a card stays a short-term stay, the hourly figure is kept as pricePerHour, and the
// price slot is left empty so it cannot be read as a night or a month.
//
// Only a number followed by "/ час", "за час" or "per hour" counts; "в час" and "погодинно" alone are
// too common in ordinary daily/hourly offers to prove the quoted price is per hour. And the hourly figure
// has to BE the listing price: "Посуточно ... 999 грн ... Почасовая оплата составляет: 350 грн/час" is a
// daily card with a side tariff.
const CURRENCY_TAIL = String.raw`(?:[⃀₴€$₸]|сом(?:ов)?|сум(?:ов)?|сўм|грн|тг|тенге|руб|usd|eur|uah|kgs|uzs|kzt)?`;
const HOURLY_AMOUNT_RE = new RegExp(
  String.raw`(\d[\d ]*)\s*${CURRENCY_TAIL}\s*(?:\/|за|per)\s*(?:час|hour|hr)(?![\p{L}\p{N}_])`,
  'giu',
);

/** Digit strings of every "<amount> / час"-style figure in the text, separators removed. */
export function hourlyAmounts(text) {
  return [...String(text ?? '').matchAll(HOURLY_AMOUNT_RE)].map((match) => match[1].replace(/\D/gu, ''));
}

/**
 * True when the listing's own price is an hourly one. A card index glued in front of the figure
 * ("1 2 500 ⃀ / час") makes the captured digits longer than the price, so the price only has to be
 * their tail. Without a price, any hourly figure counts.
 */
export function isHourlyPriced(text, price = null) {
  const amounts = hourlyAmounts(text);
  if (!amounts.length) return false;
  if (price == null) return true;
  const digits = String(Math.round(Number(price)));
  return amounts.some((amount) => amount.endsWith(digits));
}
