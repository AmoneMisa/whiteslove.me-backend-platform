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

// The comparable median depends only on the market segment (country, city,
// district, property type, deal, rooms or area) -- never on the listing being
// compared. A feed page repeats a handful of segments, and a listing popup
// asks again for the segment the feed just computed, so each segment is
// queried once and reused briefly. Before this, every popup re-ran the
// comparison against the whole active market while holding one of the API's
// ten pool connections, queuing behind feed queries.
const SEGMENT_CACHE_TTL_MS = Math.max(0, Number(process.env.MARKET_SEGMENT_CACHE_TTL_MS) || 5 * 60_000);
const SEGMENT_CACHE_MAX = 5_000;
const segmentCache = new Map();

function segmentKey(target) {
  return JSON.stringify([
    target.country,
    target.city.toLocaleLowerCase(),
    target.district ? target.district.toLocaleLowerCase() : null,
    target.property_type,
    target.deal_key,
    target.rooms,
    target.rooms == null ? target.area_sqm : null,
  ]);
}

function cachedSegment(key, now) {
  const entry = segmentCache.get(key);
  if (!entry) return null;
  if (now - entry.at >= SEGMENT_CACHE_TTL_MS) {
    segmentCache.delete(key);
    return null;
  }
  return entry.stats;
}

function rememberSegment(key, stats, now) {
  if (!SEGMENT_CACHE_TTL_MS) return;
  segmentCache.delete(key);
  segmentCache.set(key, { stats, at: now });
  while (segmentCache.size > SEGMENT_CACHE_MAX) segmentCache.delete(segmentCache.keys().next().value);
}

export function clearMarketSegmentCache() {
  segmentCache.clear();
}

export async function attachMarketComparisons(listings, rates) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;

  const rateEntries = safeRateEntries(rates);
  if (!rateEntries.length) return listings;

  const listingTargets = listings.map((listing) => buildTarget(listing, rates)).filter(Boolean);
  if (!listingTargets.length) return listings;

  const now = Date.now();
  const statsBySegment = new Map();
  const pending = new Map();
  for (const target of listingTargets) {
    const segment = segmentKey(target);
    if (statsBySegment.has(segment) || pending.has(segment)) continue;
    const cached = cachedSegment(segment, now);
    if (cached) statsBySegment.set(segment, cached);
    else pending.set(segment, { ...target, key: segment });
  }
  const targets = [...pending.values()];

  const comparatorPriceUsd = priceUsdSql('c', rateEntries);
  // One candidate subquery per segment, with the segment's values bound as
  // parameters. Joining a jsonb_to_recordset CTE hid the values from the
  // planner, and an OR-ed optional district predicate kept rooms
  // and district out of the index condition: a single Tashkent 2-room target
  // read its whole city/deal segment through the wrong index and filtered
  // almost all of it away. Bound values give the planner real selectivity, so
  // rooms targets seek listings_market_rooms_expr_idx and area targets seek
  // listings_market_area_expr_idx on every column they constrain.
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const candidateBranch = (target) => {
    const byRooms = target.rooms != null;
    const segment = [
      `UPPER(c.country) = ${bind(target.country)}`,
      `LOWER(BTRIM(COALESCE(c.city, ''))) = LOWER(BTRIM(${bind(target.city)}::text))`,
      `c.property_type = ${bind(target.property_type)}`,
      `(CASE WHEN c.room_only THEN 'roomRent' ELSE c.deal_type END) = ${bind(target.deal_key)}`,
    ];
    if (byRooms) {
      segment.push(`c.rooms = ${bind(target.rooms)}::integer`);
    } else {
      const area = bind(target.area_sqm);
      segment.push(
        'c.area_sqm IS NOT NULL',
        `c.area_sqm BETWEEN ${area}::double precision - GREATEST(5.0, ${area}::double precision * 0.15)
         AND ${area}::double precision + GREATEST(5.0, ${area}::double precision * 0.15)`,
      );
    }
    if (target.district) {
      segment.push(`LOWER(BTRIM(COALESCE(c.district, ''))) = LOWER(BTRIM(${bind(target.district)}::text))`);
    }
    return `
      SELECT
        ${bind(target.key)}::text AS key,
        ${comparatorPriceUsd} AS price_usd,
        c.dedupe_key,
        c.created_at,
        c.id
      FROM listings c
      WHERE c.active = TRUE
        AND c.price IS NOT NULL
        AND ${segment.join('\n        AND ')}
        AND COALESCE(c.created_at, c.first_seen_at) >= NOW() - (${MARKET_MAX_AGE_DAYS} * INTERVAL '1 day')
        AND NOT c.commercial`;
  };
  const candidates = targets.map(candidateBranch);
  const sql = `
    WITH candidates AS (
      ${candidates.join('\n      UNION ALL\n')}
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

  if (targets.length) {
    const { rows } = await pool.query(sql, params);
    const byKey = new Map(rows.map((row) => [String(row.key), {
      comparableCount: Number(row.comparable_count) || 0,
      medianUsd: row.median_usd == null ? null : Number(row.median_usd),
    }]));
    for (const segment of pending.keys()) {
      const stats = byKey.get(segment) || { comparableCount: 0, medianUsd: null };
      statsBySegment.set(segment, stats);
      rememberSegment(segment, stats, now);
    }
  }
  const targetByKey = new Map(listingTargets.map((target) => [target.key, target]));

  return listings.map((listing) => {
    const key = targetKey(listing);
    const target = targetByKey.get(key);
    const stats = (target && statsBySegment.get(segmentKey(target))) || { comparableCount: 0, medianUsd: null };
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
