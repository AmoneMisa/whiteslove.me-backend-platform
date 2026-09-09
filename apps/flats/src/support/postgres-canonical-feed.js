import {pool} from '../infrastructure/database/pool.js';
import {buildMemberWhere, canUseFastFeedPath} from '../infrastructure/search/postgres-search-fast-core.js';

const CURSOR_VERSION = 1;

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return parsed?.v === CURSOR_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

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

async function timedQuery(sql, params) {
  const startedAt = performance.now();
  const result = await pool.query(sql, params);
  return {
    result,
    ms: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

export function canUseCanonicalFeedPath(filters, searchMatches) {
  const sort = filters?.sort || 'newest';
  if (!['newest', 'oldest', 'priceAsc', 'priceDesc'].includes(sort)) return false;
  // Reuse the structured-feed eligibility contract while allowing price sorts.
  return canUseFastFeedPath({...filters, sort: 'newest'}, searchMatches);
}

// Same eligibility contract as the canonical feed (no free-text search, no
// curated custom-source URLs, no single-listing lookup), but sort is
// irrelevant for an aggregate response and statsOnly/includeStats are exactly
// the case this path exists for, so they are not excluded here.
export function canUseMemberStatsPath(filters, searchMatches) {
  return canUseFastFeedPath({...filters, sort: 'newest', includeStats: false, statsOnly: false}, searchMatches);
}

// Statistics used to be computed by re-deriving dedupe (ROW_NUMBER() over a
// window) and every filter predicate from the wide `listings` table on every
// request -- an unindexed full scan for JSONB predicates and no help from the
// dedupe-at-write-time model 037/040 built for the ordinary feed. Once a
// request is eligible for the canonical feed path, its stats are eligible for
// the exact same pre-deduped, indexed listing_public_feed_members table:
// filter there (buildMemberWhere, already covered by the 040 partial
// indexes), and only join back to `listings` for the couple of fields that
// still live in JSONB (microdistrict, the anti-fake heuristics) -- over the
// already-filtered, already-deduped row set rather than the whole table.
export async function computeMemberStatistics({filters, countries, rates}) {
  const startedAt = performance.now();
  const {params: baseParams, where: memberWhere} = buildMemberWhere({
    filters,
    countries,
    maxAgeDays: filters.maxAgeDays,
    rates,
  });

  // buildMemberWhere does not encode the longRent/roomOnly split (room shares
  // are stored as deal_type=longRent + room_only=TRUE); mirror the general
  // path's predicate here so a longRent stats request excludes room shares
  // exactly like the general path already does.
  const where = filters.dealType === 'longRent' && filters.roomOnly !== true
    ? `${memberWhere}\n      AND m.room_only = FALSE`
    : memberWhere;

  const priceUsdExpr = priceUsdSql('m', rates);

  const statsSql = `
    WITH visible AS MATERIALIZED (
      SELECT
        m.by_agency, m.room_only,
        ${priceUsdExpr} AS price_usd,
        m.country, m.city, m.district, m.metro,
        NULLIF(BTRIM(l.data->>'microdistrict'), '') AS microdistrict,
        COALESCE(m.first_seen_at, m.created_at) AS activity_at,
        COALESCE(
          m.commission = TRUE
          OR (m.commission_percent IS NOT NULL AND m.commission_percent > 0),
          FALSE
        ) AS has_commission,
        COALESCE(
          m.commission = FALSE
          OR m.commission_percent = 0,
          FALSE
        ) AS no_commission,
        COALESCE(
          l.data->>'duplicatePhotoRisk' IN ('high', 'very_high')
          OR l.data->'antiFake' @> '{"suspectedClone":true}'::jsonb
          OR l.data->'antiFake' @> '{"conflictingClone":true}'::jsonb,
          FALSE
        ) AS suspected_fake,
        CASE
          WHEN m.room_only THEN 'roomRent'
          WHEN m.deal_type IN ('sale', 'longRent', 'shortRent') THEN m.deal_type
          ELSE 'unknown'
        END AS deal_key
      FROM listing_public_feed_members m
      JOIN listings l ON l.id = m.listing_id
      WHERE m.is_canonical
        AND ${where}
    ),
    raw_totals AS (
      SELECT
        COUNT(*)::int AS raw_total,
        COUNT(*) FILTER (WHERE NOT m.is_canonical)::int AS duplicates_rejected
      FROM listing_public_feed_members m
      WHERE ${where}
    ),
    totals AS (
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE by_agency = FALSE)::int AS owners,
        COUNT(*) FILTER (WHERE by_agency = TRUE)::int AS agencies,
        COUNT(*) FILTER (WHERE has_commission)::int AS commission,
        COUNT(*) FILTER (WHERE no_commission)::int AS no_commission,
        COUNT(*) FILTER (WHERE suspected_fake)::int AS suspected_fake
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
      FROM visible
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
      FROM visible c
      JOIN deal_rows d ON d.key = c.deal_key
      WHERE c.price_usd IS NOT NULL AND c.price_usd > 0 AND d.median_usd IS NOT NULL AND d.median_usd > 0
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
        geo.dimension, geo.label,
        COUNT(*)::int AS count,
        COUNT(v.price_usd)::int AS price_count,
        ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.price_usd))::numeric, 2) AS median_usd,
        ROUND(MIN(v.price_usd)::numeric, 2) AS min_usd,
        ROUND(MAX(v.price_usd)::numeric, 2) AS max_usd
      FROM visible v
      CROSS JOIN LATERAL (VALUES
        ('country', NULLIF(BTRIM(v.country), '')),
        ('city', NULLIF(BTRIM(v.city), '')),
        ('district', NULLIF(BTRIM(v.district), '')),
        ('microdistrict', v.microdistrict),
        ('metro', NULLIF(BTRIM(v.metro), ''))
      ) AS geo(dimension, label)
      WHERE geo.label IS NOT NULL
      GROUP BY GROUPING SETS ((geo.dimension, geo.label), (v.deal_key, geo.dimension, geo.label))
    ),
    geo_ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY deal_key, dimension ORDER BY count DESC, label ASC) AS position
      FROM geo_rows
    ),
    geo_json AS (
      SELECT deal_key, dimension,
        JSONB_AGG(JSONB_BUILD_OBJECT(
          'label', label, 'count', count, 'priceCount', price_count,
          'medianUsd', median_usd, 'minUsd', min_usd, 'maxUsd', max_usd
        ) ORDER BY count DESC, label ASC) AS items
      FROM geo_ranked
      WHERE position <= 12
      GROUP BY deal_key, dimension
    ),
    geo_by_deal_json AS (
      SELECT deal_key, JSONB_OBJECT_AGG(dimension, items) AS dimensions
      FROM geo_json WHERE deal_key IS NOT NULL GROUP BY deal_key
    ),
    activity_rows AS (
      SELECT DATE_TRUNC('day', activity_at)::date AS day, COUNT(*)::int AS count
      FROM visible WHERE activity_at IS NOT NULL GROUP BY 1 ORDER BY 1
    )
    SELECT
      (SELECT total FROM totals) AS total,
      (SELECT raw_total FROM raw_totals) AS raw_total,
      COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'key', key, 'count', count, 'priceCount', price_count,
        'medianUsd', median_usd, 'averageUsd', average_usd, 'minUsd', min_usd, 'maxUsd', max_usd
      ) ORDER BY count DESC, key ASC) FROM deal_rows), '[]'::jsonb) AS deal_types,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, bands) FROM price_band_json), '{}'::jsonb) AS price_bands_by_deal,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, samples) FROM price_band_json), '{}'::jsonb) AS price_band_samples_by_deal,
      COALESCE((SELECT JSONB_OBJECT_AGG(dimension, items) FROM geo_json WHERE deal_key IS NULL), '{}'::jsonb) AS geographies,
      COALESCE((SELECT JSONB_OBJECT_AGG(deal_key, dimensions) FROM geo_by_deal_json), '{}'::jsonb) AS geographies_by_deal,
      (SELECT JSONB_BUILD_OBJECT(
        'owners', owners,
        'agencies', agencies,
        'commission', commission,
        'noCommission', no_commission
      ) FROM totals) AS ownership,
      COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT('date', day, 'count', count) ORDER BY day) FROM activity_rows), '[]'::jsonb) AS activity,
      JSONB_BUILD_OBJECT(
        'duplicatesRejected', (SELECT duplicates_rejected FROM raw_totals),
        'suspectedFake', (SELECT suspected_fake FROM totals)
      ) AS quality
  `;

  const {result, ms} = await timedQuery(statsSql, baseParams);
  const row = result.rows[0] || {};

  const statistics = {
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

  return {
    count: statistics.total,
    listings: [],
    statistics,
    nextCursor: null,
    queryMs: Math.round((performance.now() - startedAt) * 10) / 10,
    countMs: 0,
    pageMs: ms,
    searchPath: 'postgres-canonical-feed-stats',
  };
}

export async function searchCanonicalFeed({filters, countries, rates}) {
  const startedAt = performance.now();
  const {params: baseParams, where} = buildMemberWhere({
    filters,
    countries,
    maxAgeDays: filters.maxAgeDays,
    rates,
  });

  const sort = filters.sort || 'newest';
  const priceUsdExpr = priceUsdSql('m', rates);
  const cursor = decodeCursor(filters.cursor);
  const pageParams = [...baseParams];
  const addPage = (value) => {
    pageParams.push(value);
    return `$${pageParams.length}`;
  };
  const pageWhere = [];
  let useCursor = false;

  if (cursor && cursor.sort === sort && cursor.id != null) {
    const idParam = addPage(String(cursor.id));

    if (sort === 'newest' || sort === 'oldest') {
      if (cursor.t) {
        const timeParam = addPage(cursor.t);
        if (sort === 'newest') {
          pageWhere.push(`(m.created_at < ${timeParam}::timestamptz OR (m.created_at = ${timeParam}::timestamptz AND m.listing_id < ${idParam}::bigint) OR m.created_at IS NULL)`);
        } else {
          pageWhere.push(`(m.created_at > ${timeParam}::timestamptz OR (m.created_at = ${timeParam}::timestamptz AND m.listing_id > ${idParam}::bigint) OR m.created_at IS NULL)`);
        }
      } else {
        pageWhere.push(`m.created_at IS NULL AND m.listing_id ${sort === 'newest' ? '<' : '>'} ${idParam}::bigint`);
      }
      useCursor = true;
    } else if (sort === 'priceAsc' || sort === 'priceDesc') {
      const ascending = sort === 'priceAsc';
      if (cursor.p != null && Number.isFinite(Number(cursor.p))) {
        const priceParam = addPage(Number(cursor.p));
        if (ascending) {
          pageWhere.push(`(${priceUsdExpr} > ${priceParam}::double precision OR (${priceUsdExpr} = ${priceParam}::double precision AND m.listing_id > ${idParam}::bigint) OR ${priceUsdExpr} IS NULL)`);
        } else {
          pageWhere.push(`(${priceUsdExpr} < ${priceParam}::double precision OR (${priceUsdExpr} = ${priceParam}::double precision AND m.listing_id < ${idParam}::bigint) OR ${priceUsdExpr} IS NULL)`);
        }
      } else {
        pageWhere.push(`${priceUsdExpr} IS NULL AND m.listing_id ${ascending ? '>' : '<'} ${idParam}::bigint`);
      }
      useCursor = true;
    }
  }

  const cursorCount = Number(cursor?.c);
  const hasCursorCount = useCursor && Number.isSafeInteger(cursorCount) && cursorCount >= 0;
  const limit = Math.max(1, Math.min(Number(filters.limit) || 40, 60));
  const fetchLimit = limit + 1;
  const limitParam = addPage(fetchLimit);
  const offset = useCursor ? 0 : Math.max(0, Number(filters.offset) || 0);
  const offsetParam = addPage(offset);

  let orderBy;
  let finalOrderBy;
  if (sort === 'oldest') {
    orderBy = 'm.created_at ASC NULLS LAST, m.listing_id ASC';
    finalOrderBy = 'page.created_at ASC NULLS LAST, page.db_id ASC';
  } else if (sort === 'priceAsc') {
    orderBy = `${priceUsdExpr} ASC NULLS LAST, m.listing_id ASC`;
    finalOrderBy = 'page.price_usd ASC NULLS LAST, page.db_id ASC';
  } else if (sort === 'priceDesc') {
    orderBy = `${priceUsdExpr} DESC NULLS LAST, m.listing_id DESC`;
    finalOrderBy = 'page.price_usd DESC NULLS LAST, page.db_id DESC';
  } else {
    orderBy = 'm.created_at DESC NULLS LAST, m.listing_id DESC';
    finalOrderBy = 'page.created_at DESC NULLS LAST, page.db_id DESC';
  }

  // listing_public_feed_members.is_canonical is the winner flag maintained by
  // refresh_listing_public_feed_canonical() (migration 040), so the winner set
  // is reachable as a partial index rather than as a join against
  // listing_public_feed_canonical. That lets the ordered indexes from 040 serve
  // this ORDER BY directly: a page reads LIMIT rows instead of sorting the
  // whole filtered set.
  const pageSql = `
    WITH page AS MATERIALIZED (
      SELECT
        m.listing_id AS db_id,
        m.created_at,
        ${priceUsdExpr} AS price_usd
      FROM listing_public_feed_members AS m
      WHERE m.is_canonical
        AND ${where}
        ${pageWhere.length ? `AND ${pageWhere.join('\n        AND ')}` : ''}
      ORDER BY ${orderBy}
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    )
    SELECT page.*, l.data
    FROM page
    LEFT JOIN listings AS l ON l.id = page.db_id
    ORDER BY ${finalOrderBy}
  `;

  // A window count carried inside the page query would be planned below the
  // Limit, so the whole result set would still be computed on every uncursored
  // page and the ordered index could never terminate early. Run the count
  // beside the page instead: it is an index-only scan of the same partial
  // index, and cursor pages skip it entirely by carrying the total forward.
  const countSql = `
    SELECT COUNT(*)::int AS count
    FROM listing_public_feed_members AS m
    WHERE m.is_canonical
      AND ${where}
  `;

  let pageTimed;
  let countTimed = null;
  if (hasCursorCount) {
    pageTimed = await timedQuery(pageSql, pageParams);
  } else {
    [pageTimed, countTimed] = await Promise.all([
      timedQuery(pageSql, pageParams),
      timedQuery(countSql, baseParams),
    ]);
  }

  const pageRows = pageTimed.result.rows.filter((row) => row.db_id != null);
  const hasMore = pageRows.length > limit;
  const rows = pageRows.slice(0, limit);

  const count = hasCursorCount
    ? cursorCount
    : (Number(countTimed?.result.rows[0]?.count) || 0);

  let nextCursor = null;
  if (hasMore && rows.length) {
    const last = rows[rows.length - 1];
    if (sort === 'priceAsc' || sort === 'priceDesc') {
      nextCursor = encodeCursor({
        v: CURSOR_VERSION,
        sort,
        p: last.price_usd == null ? null : Number(last.price_usd),
        id: String(last.db_id),
        c: count,
      });
    } else {
      const time = last.created_at instanceof Date
        ? last.created_at.toISOString()
        : (last.created_at ? new Date(last.created_at).toISOString() : null);
      nextCursor = encodeCursor({
        v: CURSOR_VERSION,
        sort,
        t: time,
        id: String(last.db_id),
        c: count,
      });
    }
  }

  return {
    count,
    listings: rows.map((row) => row.data || {}),
    nextCursor,
    countMs: countTimed?.ms ?? 0,
    pageMs: pageTimed.ms,
    queryMs: Math.round((performance.now() - startedAt) * 10) / 10,
    searchPath: sort === 'priceAsc' || sort === 'priceDesc'
      ? 'postgres-canonical-feed-price'
      : 'postgres-canonical-feed',
  };
}
