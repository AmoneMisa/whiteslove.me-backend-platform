// Statistics aggregate whatever price a source published, so one listing with a
// price of 0 or a sale price filed under rent drags a min/max bar from 0 to 11M.
// Anything outside these USD bounds is treated as "no usable price" for the
// aggregates only; the listing itself is untouched and still shown in the feed.
export const PLAUSIBLE_PRICE_USD = {
  sale: [3000, 20_000_000],
  // A flat on a long lease does not cost under 60 USD a month and a night does not cost under 8 or over
  // 1 500: anything outside is a parse error (glued digits, a phone number, a per-month price in a
  // per-night slot), not a real price.
  longRent: [60, 30_000],
  shortRent: [8, 1_500],
  roomRent: [15, 5_000],
  unknown: [1, 20_000_000],
};

export function plausiblePriceUsdSql(priceUsdExpr, dealTypeExpr, roomOnlyExpr) {
  const dealKey = `(CASE
      WHEN ${roomOnlyExpr} IS TRUE THEN 'roomRent'
      WHEN ${dealTypeExpr} IN ('sale', 'longRent', 'shortRent') THEN ${dealTypeExpr}
      ELSE 'unknown'
    END)`;
  const bounds = Object.entries(PLAUSIBLE_PRICE_USD)
    .map(([key, [min, max]]) => `WHEN '${key}' THEN (p.value >= ${min} AND p.value <= ${max})`)
    .join(' ');
  return `(SELECT CASE WHEN (CASE ${dealKey} ${bounds} ELSE FALSE END) THEN p.value END
    FROM (SELECT ${priceUsdExpr} AS value) p)`;
}

// Histogram of plausible prices per deal type, trimmed to the 2nd–98th
// percentile so a handful of leftovers cannot flatten the whole curve.
export const PRICE_DISTRIBUTION_BUCKETS = 24;

/**
 * Ukrainian sources quote flats in dollars but the crawler labels a bare number
 * with the country default ("69 000 UAH" for a 45 m² flat, "150 UAH" a month).
 * A hryvnia price in these ranges cannot be a real flat price in hryvnia, so
 * the number is read as USD. Only Ukraine: elsewhere (Romania, Kazakhstan) the
 * same low numbers are often genuine local-currency prices.
 *
 * Returns 'USD' when the label should be replaced, otherwise null.
 */
export function inferHardCurrency({ country, dealType, price, currency, roomOnly = false } = {}) {
  if (String(country || '').toUpperCase() !== 'UA') return null;
  if (String(currency || '').toUpperCase() !== 'UAH') return null;
  const amount = Number(price);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (dealType === 'sale' && amount >= 5_000 && amount < 125_000) return 'USD';
  if (dealType === 'longRent' && !roomOnly && amount >= 100 && amount < 2_500) return 'USD';
  return null;
}
