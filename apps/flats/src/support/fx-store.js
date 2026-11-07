// Daily FX refresh that persists the rates and recomputes the stored USD price.
//
// The live table comes from fx.js (getRates, cached in memory with a static
// fallback). This module writes it to fx_rates and then rewrites
// listing_public_feed_members.price_usd for rows whose value actually changed,
// so a quiet day costs one cheap scan and no row writes.

import {pool} from '../infrastructure/database/pool.js';
import {getRates} from './fx.js';

const CURRENCY = /^[A-Z]{3}$/;

export function storableRates(rates) {
  return Object.entries(rates || {})
    .map(([currency, rate]) => [String(currency).toUpperCase(), Number(rate)])
    .filter(([currency, rate]) => CURRENCY.test(currency) && Number.isFinite(rate) && rate > 0);
}

export async function refreshStoredFxRates({db = pool, fetchRates = getRates} = {}) {
  const {rates, at} = await fetchRates();
  // at === 0 means only the static fallback is available; do not overwrite
  // stored live rates with approximations.
  if (!at) return {live: false, rates: 0, recomputed: 0};

  const entries = storableRates(rates);
  if (!entries.some(([currency]) => currency === 'USD')) throw new Error('fx rates have no USD base');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO fx_rates (currency, units_per_usd, fetched_at)
       SELECT c, r, now() FROM unnest($1::text[], $2::float8[]) AS t(c, r)
       ON CONFLICT (currency) DO UPDATE
         SET units_per_usd = EXCLUDED.units_per_usd, fetched_at = EXCLUDED.fetched_at`,
      [entries.map(([c]) => c), entries.map(([, r]) => r)],
    );
    const result = await client.query(
      `UPDATE listing_public_feed_members m
          SET price_usd = m.price / r.units_per_usd
         FROM fx_rates r
        WHERE r.currency = upper(m.currency)
          AND m.price IS NOT NULL
          AND m.price_usd IS DISTINCT FROM m.price / r.units_per_usd`,
    );
    await client.query('COMMIT');
    return {live: true, rates: entries.length, recomputed: result.rowCount};
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
