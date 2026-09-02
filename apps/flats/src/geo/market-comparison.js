import {pool} from '../infrastructure/database/pool.js';
import { toUsd } from '../support/fx.js';

const MARKET_MAX_AGE_DAYS = 14;
const MIN_COMPARABLES = 3;

function safeRateEntries(rates) {
  return Object.entries(rates || {})
    .map(([currency, rate]) => [String(currency).toUpperCase(), Number(rate)])
    .filter(([currency, rate]) => /^[A-Z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0);
}

function priceUsdSql(alias, rateEntries) {
  if (!rateEntries.length) return 'NULL::double precision';
  const cases = rateEntries
    .map(([currency, rate]) => `WHEN '${currency}' THEN ${alias}.price / ${rate}`)
    .join(' ');
  return `(CASE UPPER(${alias}.currency) ${cases} ELSE NULL END)`;
}

function dealKey(listing) {
  if (listing?.roomOnly === true) return 'roomRent';
  return listing?.dealType || null;
}

function targetKey(listing) {
  return `${String(listing?.source || '').toLowerCase()}:${String(listing?.country || '').toUpperCase()}:${String(listing?.id || '')}`;
}

function buildTarget(listing, rates) {
  const price = Number(listing?.price);
  const priceUsd = toUsd(Number.isFinite(price) ? price : null, listing?.currency, rates);
  const rooms = listing?.rooms == null ? null : Number(listing.rooms);
  const areaSqm = listing?.areaSqm == null ? null : Number(listing.areaSqm);
  const city = String(listing?.city || '').trim();
  const propertyType = String(listing?.propertyType || '').trim();
  const deal = dealKey(listing);

  if (!Number.isFinite(priceUsd) || !city || !propertyType || !deal || (rooms == null && !Number.isFinite(areaSqm))) return null;

  return {
    key: targetKey(listing),
    country: String(listing.country || '').toUpperCase(),
    city,
    district: String(listing.district || '').trim() || null,
    property_type: propertyType,
    deal_key: deal,
    rooms: Number.isFinite(rooms) ? rooms : null,
    area_sqm: Number.isFinite(areaSqm) ? areaSqm : null,
    price_usd: priceUsd,
  };
}

export async function attachMarketComparisons(listings, rates) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;

  const rateEntries = safeRateEntries(rates);
  if (!rateEntries.length) return listings;

  const targets = listings.map((listing) => buildTarget(listing, rates)).filter(Boolean);
  if (!targets.length) return listings;

  const comparatorPriceUsd = priceUsdSql('c', rateEntries);
  const sql = `
    WITH targets AS MATERIALIZED (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS t(
        key text,
        country text,
        city text,
        district text,
        property_type text,
        deal_key text,
        rooms integer,
        area_sqm double precision,
        price_usd double precision
      )
    ),
    room_candidates AS (
      SELECT
        t.key,
        ${comparatorPriceUsd} AS price_usd,
        c.dedupe_key,
        c.created_at,
        c.id
      FROM targets t
      JOIN listings c
        ON t.rooms IS NOT NULL
       AND c.active = TRUE
       AND c.price IS NOT NULL
       AND UPPER(c.country) = t.country
       AND LOWER(BTRIM(COALESCE(c.city, ''))) = LOWER(BTRIM(t.city))
       AND c.property_type = t.property_type
       AND (CASE WHEN c.data @> '{"roomOnly":true}'::jsonb THEN 'roomRent' ELSE c.deal_type END) = t.deal_key
       AND c.rooms = t.rooms
       AND (t.district IS NULL OR LOWER(BTRIM(COALESCE(c.district, ''))) = LOWER(BTRIM(t.district)))
       AND COALESCE(c.created_at, c.first_seen_at) >= NOW() - (${MARKET_MAX_AGE_DAYS} * INTERVAL '1 day')
       AND NOT (c.data @> '{"commercial":true}'::jsonb)
    ),
    area_candidates AS (
      SELECT
        t.key,
        ${comparatorPriceUsd} AS price_usd,
        c.dedupe_key,
        c.created_at,
        c.id
      FROM targets t
      JOIN listings c
        ON t.rooms IS NULL
       AND t.area_sqm IS NOT NULL
       AND c.active = TRUE
       AND c.price IS NOT NULL
       AND UPPER(c.country) = t.country
       AND LOWER(BTRIM(COALESCE(c.city, ''))) = LOWER(BTRIM(t.city))
       AND c.property_type = t.property_type
       AND (CASE WHEN c.data @> '{"roomOnly":true}'::jsonb THEN 'roomRent' ELSE c.deal_type END) = t.deal_key
       AND c.area_sqm IS NOT NULL
       AND c.area_sqm BETWEEN
         t.area_sqm - GREATEST(5.0, t.area_sqm * 0.15)
         AND t.area_sqm + GREATEST(5.0, t.area_sqm * 0.15)
       AND (t.district IS NULL OR LOWER(BTRIM(COALESCE(c.district, ''))) = LOWER(BTRIM(t.district)))
       AND COALESCE(c.created_at, c.first_seen_at) >= NOW() - (${MARKET_MAX_AGE_DAYS} * INTERVAL '1 day')
       AND NOT (c.data @> '{"commercial":true}'::jsonb)
    ),
    candidates AS (
      SELECT * FROM room_candidates
      UNION ALL
      SELECT * FROM area_candidates
    ),
    deduped AS (
      SELECT DISTINCT ON (key, dedupe_key)
        key,
        price_usd
      FROM candidates
      WHERE price_usd IS NOT NULL
      ORDER BY key, dedupe_key, created_at DESC NULLS LAST, id DESC
    )
    SELECT
      key,
      COUNT(*)::int AS comparable_count,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_usd))::numeric, 2) AS median_usd
    FROM deduped
    GROUP BY key
  `;

  const { rows } = await pool.query(sql, [JSON.stringify(targets)]);
  const byKey = new Map(rows.map((row) => [String(row.key), {
    comparableCount: Number(row.comparable_count) || 0,
    medianUsd: row.median_usd == null ? null : Number(row.median_usd),
  }]));
  const targetByKey = new Map(targets.map((target) => [target.key, target]));

  return listings.map((listing) => {
    const key = targetKey(listing);
    const stats = byKey.get(key) || { comparableCount: 0, medianUsd: null };
    const target = targetByKey.get(key);
    const comparableMedian = stats.comparableCount >= MIN_COMPARABLES && Number.isFinite(stats.medianUsd)
      ? stats.medianUsd
      : null;
    const priceUsd = target && Number.isFinite(target.price_usd) ? target.price_usd : null;
    const priceRatio = priceUsd != null && comparableMedian != null && comparableMedian > 0
      ? priceUsd / comparableMedian
      : null;
    const goodPrice = Boolean(priceRatio != null && priceRatio < 1);

    return {
      ...listing,
      marketComparison: {
        goodPrice,
        medianUsd: comparableMedian,
        comparableCount: stats.comparableCount,
        priceUsd,
        priceRatio,
      },
    };
  });
}
