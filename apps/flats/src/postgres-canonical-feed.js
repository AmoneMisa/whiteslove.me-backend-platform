import {pool} from './db.js';
import {buildMemberWhere, canUseFastFeedPath} from './infrastructure/search/postgres-search-fast-core.js';

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

  const includeWindowCount = !useCursor;
  const pageSql = `
    WITH page AS MATERIALIZED (
      SELECT
        m.listing_id AS db_id,
        m.created_at,
        ${priceUsdExpr} AS price_usd
        ${includeWindowCount ? ', COUNT(*) OVER()::int AS total_count' : ''}
      FROM listing_public_feed_canonical AS canonical
      JOIN listing_public_feed_members AS m
        ON m.listing_id = canonical.listing_id
      WHERE ${where}
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

  const countSql = `
    SELECT COUNT(*)::int AS count
    FROM listing_public_feed_canonical AS canonical
    JOIN listing_public_feed_members AS m
      ON m.listing_id = canonical.listing_id
    WHERE ${where}
  `;

  let pageTimed;
  let countTimed = null;
  if (useCursor && !hasCursorCount) {
    [pageTimed, countTimed] = await Promise.all([
      timedQuery(pageSql, pageParams),
      timedQuery(countSql, baseParams),
    ]);
  } else {
    pageTimed = await timedQuery(pageSql, pageParams);
  }

  const pageRows = pageTimed.result.rows.filter((row) => row.db_id != null);
  const hasMore = pageRows.length > limit;
  const rows = pageRows.slice(0, limit);

  let count;
  if (hasCursorCount) {
    count = cursorCount;
  } else if (countTimed) {
    count = Number(countTimed.result.rows[0]?.count) || 0;
  } else if (pageTimed.result.rows.length) {
    count = Number(pageTimed.result.rows[0]?.total_count) || 0;
  } else {
    // OFFSET beyond the final row has no window-count carrier.
    countTimed = await timedQuery(countSql, baseParams);
    count = Number(countTimed.result.rows[0]?.count) || 0;
  }

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
