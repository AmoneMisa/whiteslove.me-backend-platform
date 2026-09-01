import {pool} from './db.js';
import {buildMemberWhere, canUseFastFeedPath} from './postgres-search-fast-core.js';

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

export function canUsePriceFeedPath(filters, searchMatches) {
  if (!['priceAsc', 'priceDesc'].includes(filters?.sort)) return false;
  return canUseFastFeedPath({...filters, sort: 'newest'}, searchMatches);
}

export async function searchPriceSortedFeed({filters, countries, rates}) {
  const startedAt = performance.now();
  const {params: baseParams, where} = buildMemberWhere({
    filters,
    countries,
    maxAgeDays: filters.maxAgeDays,
    rates,
  });
  const priceUsdExpr = priceUsdSql('m', rates);

  const pageParams = [...baseParams];
  const addPage = (value) => {
    pageParams.push(value);
    return `$${pageParams.length}`;
  };

  const sort = filters.sort;
  const ascending = sort === 'priceAsc';
  const cursor = decodeCursor(filters.cursor);
  const pageWhere = [];
  let useCursor = false;

  if (cursor && cursor.sort === sort && cursor.id != null) {
    const idParam = addPage(String(cursor.id));
    if (cursor.p != null && Number.isFinite(Number(cursor.p))) {
      const priceParam = addPage(Number(cursor.p));
      if (ascending) {
        pageWhere.push(`(d.price_usd > ${priceParam}::double precision OR (d.price_usd = ${priceParam}::double precision AND d.db_id > ${idParam}::bigint) OR d.price_usd IS NULL)`);
      } else {
        pageWhere.push(`(d.price_usd < ${priceParam}::double precision OR (d.price_usd = ${priceParam}::double precision AND d.db_id < ${idParam}::bigint) OR d.price_usd IS NULL)`);
      }
    } else {
      pageWhere.push(`d.price_usd IS NULL AND d.db_id ${ascending ? '>' : '<'} ${idParam}::bigint`);
    }
    useCursor = true;
  }

  const cursorCount = Number(cursor?.c);
  const hasCursorCount = useCursor && Number.isSafeInteger(cursorCount) && cursorCount >= 0;
  const limit = Math.max(1, Math.min(Number(filters.limit) || 40, 60));
  const fetchLimit = limit + 1;
  const limitParam = addPage(fetchLimit);
  const offset = useCursor ? 0 : Math.max(0, Number(filters.offset) || 0);
  const offsetParam = addPage(offset);
  const orderBy = ascending
    ? 'd.price_usd ASC NULLS LAST, d.db_id ASC'
    : 'd.price_usd DESC NULLS LAST, d.db_id DESC';

  const baseSql = `
    WITH deduped AS MATERIALIZED (
      SELECT DISTINCT ON (m.dedupe_key)
        m.listing_id AS db_id,
        ${priceUsdExpr} AS price_usd
      FROM listing_public_feed_members m
      WHERE ${where}
      ORDER BY m.dedupe_key, m.created_at DESC NULLS LAST, m.listing_id DESC
    ),
    page AS MATERIALIZED (
      SELECT d.db_id, d.price_usd
      FROM deduped d
      ${pageWhere.length ? `WHERE ${pageWhere.join('\n        AND ')}` : ''}
      ORDER BY ${orderBy}
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    )
  `;

  const pageOrder = orderBy.replaceAll('d.', 'p.');
  const pageSql = hasCursorCount
    ? `${baseSql}
      SELECT p.db_id, p.price_usd, l.data
      FROM page p
      LEFT JOIN listings l ON l.id = p.db_id
      ORDER BY ${pageOrder}
    `
    : `${baseSql}
      SELECT totals.count, p.db_id, p.price_usd, l.data
      FROM (SELECT COUNT(*)::int AS count FROM deduped) totals
      LEFT JOIN page p ON TRUE
      LEFT JOIN listings l ON l.id = p.db_id
      ORDER BY ${pageOrder}
    `;

  const pageTimed = await timedQuery(pageSql, pageParams);
  const pageRows = pageTimed.result.rows.filter((row) => row.db_id != null);
  const hasMore = pageRows.length > limit;
  const rows = pageRows.slice(0, limit);
  const count = hasCursorCount
    ? cursorCount
    : (Number(pageTimed.result.rows[0]?.count) || 0);

  let nextCursor = null;
  if (hasMore && rows.length) {
    const last = rows[rows.length - 1];
    nextCursor = encodeCursor({
      v: CURSOR_VERSION,
      sort,
      p: last.price_usd == null ? null : Number(last.price_usd),
      id: String(last.db_id),
      c: count,
    });
  }

  return {
    count,
    listings: rows.map((row) => row.data || {}),
    nextCursor,
    countMs: 0,
    pageMs: pageTimed.ms,
    queryMs: Math.round((performance.now() - startedAt) * 10) / 10,
    searchPath: 'postgres-feed-members-price',
  };
}
