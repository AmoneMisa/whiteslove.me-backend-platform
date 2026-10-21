import { COUNTRIES } from '../geo/countries.js';
import { PLAUSIBLE_PRICE_USD } from '../support/price-plausibility.js';

const FOREIGN_LABELS = new Set(['USD', 'EUR']);
// Relabelling guesses a currency, so it only fires when the local reading lands
// in a typical market range, not merely the wide "could exist" range above.
const RELABEL_USD = {
  sale: [5000, 2_000_000],
  longRent: [50, 5000],
  shortRent: [5, 1000],
  roomRent: [20, 2000],
};

export function dealPriceKey(dealType, roomOnly) {
  if (roomOnly === true) return 'roomRent';
  return ['sale', 'longRent', 'shortRent'].includes(dealType) ? dealType : 'unknown';
}

function plausible(usd, key) {
  const [min, max] = PLAUSIBLE_PRICE_USD[key];
  return Number.isFinite(usd) && usd >= min && usd <= max;
}

function typical(usd, key) {
  const range = RELABEL_USD[key];
  return Boolean(range) && usd >= range[0] && usd <= range[1];
}

/**
 * Decides what to do with one stored price. `rates` are units per 1 USD.
 *
 *  - currency: the number is plausible as the country's own currency but not as
 *    the USD/EUR it is labelled with (an Uzbek 4 000 000 filed as EUR is sum);
 *  - clear:    the number is not a price in any reading (a phone number, digits
 *    from a username, 0), so the price is dropped instead of guessed;
 *  - report:   a rent-labelled listing priced like a sale. Reported only: the
 *    deal type is a semantic call that is not made here.
 *
 * Returns null when the price is fine or cannot be judged.
 */
export function planPriceRepair(row, rates) {
  if (row?.price == null) return null;
  const price = Number(row.price);
  if (!Number.isFinite(price)) return null;
  const currency = String(row.currency || '').toUpperCase();
  const rate = rates?.[currency];
  if (!currency || !rate) return null;
  const key = dealPriceKey(row.deal_type, row.room_only);

  if (price <= 0) return { action: 'clear', reason: 'non-positive-price', key };
  if (plausible(price / rate, key)) return null;

  const local = COUNTRIES[String(row.country || '').toUpperCase()]?.currency?.toUpperCase();
  if (local && local !== currency && FOREIGN_LABELS.has(currency) && rates[local] && typical(price / rates[local], key)) {
    return { action: 'currency', reason: 'currency-label-is-local', currency: local, key };
  }
  // Too cheap in the labelled currency but a normal price read as USD/EUR: the
  // source quoted hard currency and the label fell back to the country default.
  // The real price is probably intact, so it is reported, never cleared.
  if (price / rate < PLAUSIBLE_PRICE_USD[key][0] && !FOREIGN_LABELS.has(currency) && typical(price, key)) {
    return { action: 'report', reason: 'price-reads-as-hard-currency', key };
  }
  if (key === 'longRent' || key === 'shortRent') {
    const [min, max] = PLAUSIBLE_PRICE_USD.sale;
    const usd = price / rate;
    if (usd >= min && usd <= max) return { action: 'report', reason: 'rent-priced-like-sale', key };
  }
  return { action: 'clear', reason: 'implausible-price', key };
}

/**
 * One batch: read the next page of listings by id (keyset), plan the repair,
 * and in apply mode rewrite the price columns and the payload copy together.
 * The original price/currency stay in data.priceRepair so a repair can be
 * reversed. Updating `price`/`currency`/`data` fires the feed sync triggers.
 */
export async function runPriceBackfillBatch(client, { afterId = 0, batchSize = 500, country = null, includeInactive = false, apply = false, rates } = {}) {
  const rows = await client.query(
    `
      SELECT id, country, source, deal_type, price, currency,
             CASE WHEN jsonb_typeof(data->'roomOnly') = 'boolean' THEN (data->>'roomOnly')::boolean END AS room_only,
             LEFT(REGEXP_REPLACE(COALESCE(title, ''), '\\s+', ' ', 'g'), 60) AS title
      FROM listings
      WHERE id > $1::bigint
        AND price IS NOT NULL
        AND ($3::text IS NULL OR country = $3)
        AND ($4::boolean OR active = TRUE)
      ORDER BY id
      LIMIT $2
    `,
    [String(afterId), batchSize, country, includeInactive],
  );
  const changes = [];
  for (const row of rows.rows) {
    const plan = planPriceRepair(row, rates);
    if (plan) {
      changes.push({
        id: String(row.id), source: row.source, country: row.country, dealType: row.deal_type,
        title: row.title, price: Number(row.price), currency: row.currency, ...plan,
      });
    }
  }
  const fixes = changes.filter((change) => change.action !== 'report');
  let updated = 0;
  if (apply && fixes.length) {
    const result = await client.query(
      `
        UPDATE listings AS l
        SET price = CASE WHEN input.action = 'clear' THEN NULL ELSE l.price END,
            currency = CASE WHEN input.action = 'currency' THEN input.currency ELSE l.currency END,
            data = jsonb_set(
              l.data
                || CASE WHEN input.action = 'clear' THEN jsonb_build_object('price', NULL)
                        ELSE jsonb_build_object('currency', input.currency) END,
              '{priceRepair}',
              jsonb_build_object('price', l.price, 'currency', l.currency, 'reason', input.reason, 'at', NOW())
            ),
            updated_at = NOW()
        FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::double precision[])
          AS input(id, action, currency, reason, price)
        WHERE l.id = input.id
          -- Skip rows changed since they were read, and rows already repaired.
          AND l.price IS NOT DISTINCT FROM input.price
          AND l.data->'priceRepair' IS NULL
      `,
      [
        fixes.map((change) => change.id),
        fixes.map((change) => change.action),
        fixes.map((change) => change.currency ?? ''),
        fixes.map((change) => change.reason),
        fixes.map((change) => change.price),
      ],
    );
    updated = result.rowCount ?? 0;
  }
  const last = rows.rows.at(-1);
  return { scanned: rows.rows.length, changes, updated, nextAfterId: last ? String(last.id) : null };
}
