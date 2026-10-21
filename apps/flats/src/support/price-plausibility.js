// Statistics aggregate whatever price a source published, so one listing with a
// price of 0 or a sale price filed under rent drags a min/max bar from 0 to 11M.
// Anything outside these USD bounds is treated as "no usable price" for the
// aggregates only; the listing itself is untouched and still shown in the feed.
export const PLAUSIBLE_PRICE_USD = {
  sale: [3000, 20_000_000],
  longRent: [30, 30_000],
  shortRent: [3, 10_000],
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
