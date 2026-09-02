import {COUNTRY_CODES} from './countries.js';
import {pool} from './infrastructure/database/pool.js';
import {getRates} from './fx.js';

const SNAPSHOT_MAX_AGE_DAYS = 14;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

let cachedSnapshot = null;
let cachedUntil = 0;
let inFlightSnapshot = null;

function safeRateEntries(rates) {
  return Object.entries(rates || {})
    .map(([currency, rate]) => [String(currency).toUpperCase(), Number(rate)])
    .filter(([currency, rate]) => /^[A-Z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0);
}

function priceUsdSql(alias, rates) {
  const entries = safeRateEntries(rates);
  if (!entries.length) return `${alias}.price`;
  const cases = entries
    .map(([currency, rate]) => `WHEN '${currency}' THEN ${alias}.price / ${rate}`)
    .join(' ');
  return `(CASE UPPER(${alias}.currency) ${cases} ELSE NULL END)`;
}

function normalizedCountries(countries) {
  return [...new Set((countries || [])
    .map((value) => String(value).trim().toUpperCase())
    .filter(Boolean))];
}

export async function computeStatisticsSnapshot({
  countries = COUNTRY_CODES,
  rates = null,
  maxAgeDays = SNAPSHOT_MAX_AGE_DAYS,
} = {}) {
  const codes = normalizedCountries(countries);
  const boundedAgeDays = Math.max(1, Math.min(Number(maxAgeDays) || SNAPSHOT_MAX_AGE_DAYS, SNAPSHOT_MAX_AGE_DAYS));
  const priceUsdExpr = priceUsdSql('m', rates);

  const sql = `
    WITH visible AS MATERIALIZED (
      SELECT
        m.listing_id,
        m.country,
        m.city,
        m.district,
        m.metro,
        m.deal_type,
        m.room_only,
        m.by_agency,
        m.commission,
        m.commission_percent,
        m.created_at,
        m.first_seen_at,
        ${priceUsdExpr} AS price_usd,
        l.data
      FROM listing_public_feed_canonical AS canonical
      JOIN listing_public_feed_members AS m
        ON m.listing_id = canonical.listing_id
      LEFT JOIN listings AS l
        ON l.id = m.listing_id
      WHERE m.country = ANY($1::text[])
        AND m.freshness_at >= NOW() - ($2::double precision * INTERVAL '1 day')
    ),
    classified AS MATERIALIZED (
      SELECT visible.*,
        CASE
          WHEN room_only IS TRUE THEN 'roomRent'
          WHEN deal_type IN ('sale', 'longRent', 'shortRent') THEN deal_type
          ELSE 'unknown'
        END AS deal_key
      FROM visible
    ),
    deal_rows AS (
      SELECT deal_key AS key,
        COUNT(*)::int AS count,
        COUNT(price_usd)::int AS price_count,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_usd))::numeric, 2) AS median_usd,
        ROUND(AVG(price_usd)::numeric, 2) AS average_usd,
        ROUND(MIN(price_usd)::numeric, 2) AS min_usd,
        ROUND(MAX(price_usd)::numeric, 2) AS max_usd
      FROM classified
      GROUP BY deal_key
    ),
    price_band_rows AS (
      SELECT c.deal_key,
        CASE
          WHEN c.price_usd / d.median_usd < 0.70 THEN 'green'
          WHEN c.price_usd / d.median_usd < 0.85 THEN 'blue'
          WHEN c.price_usd / d.median_usd <= 1.15 THEN 'pink'
          WHEN c.price_usd / d.median_usd < 1.31 THEN 'orange'
          WHEN c.price_usd / d.median_usd < 1.45 THEN 'yellow'
          ELSE 'red'
        END AS band_key,
        COUNT(*)::int AS count
      FROM classified c
      JOIN deal_rows d ON d.key = c.deal_key
      WHERE c.price_usd IS NOT NULL
        AND c.price_usd > 0
        AND d.median_usd IS NOT NULL
        AND d.median_usd > 0
      GROUP BY c.deal_key, band_key
    ),
    price_band_json AS (
      SELECT deal_key,
        JSONB_AGG(JSONB_BUILD_OBJECT('key', band_key, 'count', count) ORDER BY
          CASE band_key WHEN 'green' THEN 1 WHEN 'blue' THEN 2 WHEN 'pink' THEN 3 WHEN 'orange' THEN 4 WHEN 'yellow' THEN 5 ELSE 6 END
        ) AS bands,
        SUM(count)::int AS samples
      FROM price_band_rows
      GROUP BY deal_key
    ),
    geo_rows AS (
      SELECT CASE WHEN GROUPING(v.deal_key) = 1 THEN NULL ELSE v.deal_key END AS deal_key,
        geo.dimension,
        geo.label,
        COUNT(*)::int AS count,
        COUNT(v.price_usd)::int AS price_count,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.price_usd))::numeric, 2) AS median_usd,
        ROUND(MIN(v.price_usd)::numeric, 2) AS min_usd,
        ROUND(MAX(v.price_usd)::numeric, 2) AS max_usd
      FROM classified v
      CROSS JOIN LATERAL (VALUES
        ('country', NULLIF(BTRIM(v.country), '')),
        ('city', NULLIF(BTRIM(v.city), '')),
        ('district', NULLIF(BTRIM(v.district), '')),
        ('microdistrict', NULLIF(BTRIM(v.data->>'microdistrict'), '')),
        ('metro', NULLIF(BTRIM(v.metro), ''))
      ) AS geo(dimension, label)
      WHERE geo.label IS NOT NULL
      GROUP BY GROUPING SETS ((geo.dimension, geo.label), (v.deal_key, geo.dimension, geo.label))
    ),
    geo_ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY deal_key, dimension
        ORDER BY count DESC, label ASC
      ) AS position
      FROM geo_rows
    ),
    geo_json AS (
      SELECT deal_key, dimension,
        JSONB_AGG(JSONB_BUILD_OBJECT(
          'label', label,
          'count', count,
          'priceCount', price_count,
          'medianUsd', median_usd,
          'minUsd', min_usd,
          'maxUsd', max_usd
        ) ORDER BY count DESC, label ASC) AS items
      FROM geo_ranked
      WHERE position <= 12
      GROUP BY deal_key, dimension
    ),
    geo_by_deal_json AS (
      SELECT deal_key, JSONB_OBJECT_AGG(dimension, items) AS dimensions
      FROM geo_json
      WHERE deal_key IS NOT NULL
      GROUP BY deal_key
    ),
    activity_rows AS (
      SELECT DATE_TRUNC('day', COALESCE(first_seen_at, created_at))::date AS day,
        COUNT(*)::int AS count
      FROM visible
      WHERE COALESCE(first_seen_at, created_at) IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    ),
    raw_total AS (
      SELECT COUNT(*)::int AS count
      FROM listing_public_feed_members AS m
      WHERE m.country = ANY($1::text[])
        AND m.freshness_at >= NOW() - ($2::double precision * INTERVAL '1 day')
    )
    SELECT
      (SELECT COUNT(*)::int FROM visible) AS total,
      (SELECT count FROM raw_total) AS raw_total,
      COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'key', key,
        'count', count,
        'priceCount', price_count,
        'medianUsd', median_usd,
        'averageUsd', average_usd,
        'minUsd', min_usd,
        'maxUsd', max_usd
      ) ORDER BY count DESC, key ASC) FROM deal_rows), '[]'::jsonb) AS deal_types,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, bands) FROM price_band_json), '{}'::jsonb) AS price_bands_by_deal,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, samples) FROM price_band_json), '{}'::jsonb) AS price_band_samples_by_deal,
      COALESCE((SELECT JSONB_OBJECT_AGG(dimension, items) FROM geo_json WHERE deal_key IS NULL), '{}'::jsonb) AS geographies,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, dimensions) FROM geo_by_deal_json), '{}'::jsonb) AS geographies_by_deal,
      JSONB_BUILD_OBJECT(
        'owners', (SELECT COUNT(*)::int FROM visible WHERE by_agency = FALSE),
        'agencies', (SELECT COUNT(*)::int FROM visible WHERE by_agency = TRUE),
        'commission', (SELECT COUNT(*)::int FROM visible WHERE commission = TRUE OR COALESCE(commission_percent, 0) > 0),
        'noCommission', (SELECT COUNT(*)::int FROM visible WHERE commission = FALSE OR commission_percent = 0)
      ) AS ownership,
      COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT('date', day, 'count', count) ORDER BY day) FROM activity_rows), '[]'::jsonb) AS activity,
      JSONB_BUILD_OBJECT(
        'duplicatesRejected', GREATEST((SELECT count FROM raw_total) - (SELECT COUNT(*)::int FROM visible), 0),
        'suspectedFake', (SELECT COUNT(*)::int FROM visible WHERE
          data->>'duplicatePhotoRisk' IN ('high', 'very_high')
          OR data->'antiFake' @> '{"suspectedClone":true}'::jsonb
          OR data->'antiFake' @> '{"conflictingClone":true}'::jsonb)
      ) AS quality
  `;

  const result = await pool.query(sql, [codes, boundedAgeDays]);
  const row = result.rows[0] || {};
  return {
    total: Number(row.total) || 0,
    rawTotal: Number(row.raw_total) || 0,
    currency: 'USD',
    dealTypes: row.deal_types || [],
    priceBandsByDeal: row.price_bands_by_deal || {},
    priceBandSamplesByDeal: row.price_band_samples_by_deal || {},
    geographies: row.geographies || {},
    geographiesByDeal: row.geographies_by_deal || {},
    ownership: row.ownership || {},
    activity: row.activity || [],
    quality: row.quality || {},
  };
}

export function clearStatisticsSnapshotCache() {
  cachedSnapshot = null;
  cachedUntil = 0;
  inFlightSnapshot = null;
}

export async function getFullStatisticsSnapshot() {
  const now = Date.now();
  if (cachedSnapshot && now < cachedUntil) return cachedSnapshot;
  if (inFlightSnapshot) return inFlightSnapshot;

  inFlightSnapshot = (async () => {
    let rates = null;
    try {
      rates = (await getRates()).rates;
    } catch (err) {
      console.warn('[statistics] FX rates unavailable; using stored numeric prices:', err?.message ?? err);
    }

    const statistics = await computeStatisticsSnapshot({
      countries: COUNTRY_CODES,
      rates,
      maxAgeDays: SNAPSHOT_MAX_AGE_DAYS,
    });
    const snapshot = {
      statistics,
      generatedAt: new Date().toISOString(),
      maxAgeDays: SNAPSHOT_MAX_AGE_DAYS,
    };
    cachedSnapshot = snapshot;
    cachedUntil = Date.now() + SNAPSHOT_TTL_MS;
    return snapshot;
  })().finally(() => {
    inFlightSnapshot = null;
  });

  return inFlightSnapshot;
}

export function installStatisticsRoutes(app) {
  app.get('/api/statistics', async (_req, res) => {
    try {
      const snapshot = await getFullStatisticsSnapshot();
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      return res.json(snapshot);
    } catch (err) {
      const error = err?.message ?? String(err);
      console.error('[statistics] snapshot unavailable:', error);
      return res.status(503).json({
        error: 'Statistics temporarily unavailable',
        statistics: null,
      });
    }
  });
}
