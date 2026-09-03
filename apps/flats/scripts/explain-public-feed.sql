-- Read-only EXPLAIN harness for the structured public feed.
-- Run on production with psql after representative traffic has warmed the cache:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/flats/scripts/explain-public-feed.sql
--
-- The defaults reproduce the Tashkent long-rent paths that dominate UI traffic.
-- Change the psql variables below for other markets.
--
-- These reproduce the shapes src/support/postgres-canonical-feed.js actually
-- issues since migration 040: the winner of each dedupe group is persisted as
-- listing_public_feed_members.is_canonical, so a page is an ordered index scan
-- with a LIMIT, and the total is a separate index-only count. What to look for:
--   * the page plans as an Index Scan / Index Only Scan on a
--     listing_public_feed_members_canonical_* index with NO Sort node above it
--   * "rows removed by filter" on the page stays small (early termination)
--   * the count plans as an Index Only Scan with a high heap-fetch hit rate

\set country 'UZ'
\set city 'Tashkent'
\set deal_type 'longRent'
\set max_price_usd 1000
\set max_price_uzs 12500000
\set page_limit 41

BEGIN;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '2s';

\echo '=== fallback page: country only (no city selected) ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
WITH page AS MATERIALIZED (
  SELECT m.listing_id AS db_id, m.created_at, m.price AS price_usd
  FROM listing_public_feed_members AS m
  WHERE m.is_canonical
    AND m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
    AND m.country = :'country'
  ORDER BY m.created_at DESC NULLS LAST, m.listing_id DESC
  LIMIT :page_limit
  OFFSET 0
)
SELECT page.*, l.data
FROM page
LEFT JOIN listings AS l ON l.id = page.db_id
ORDER BY page.created_at DESC NULLS LAST, page.db_id DESC;

\echo '=== primary page: country + city + deal type ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
WITH page AS MATERIALIZED (
  SELECT m.listing_id AS db_id, m.created_at, m.price AS price_usd
  FROM listing_public_feed_members AS m
  WHERE m.is_canonical
    AND m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
    AND m.country = :'country'
    AND m.city = :'city'
    AND m.deal_type = :'deal_type'
  ORDER BY m.created_at DESC NULLS LAST, m.listing_id DESC
  LIMIT :page_limit
  OFFSET 0
)
SELECT page.*, l.data
FROM page
LEFT JOIN listings AS l ON l.id = page.db_id
ORDER BY page.created_at DESC NULLS LAST, page.db_id DESC;

\echo '=== primary count: country + city + deal type ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
SELECT COUNT(*)::int AS count
FROM listing_public_feed_members AS m
WHERE m.is_canonical
  AND m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
  AND m.country = :'country'
  AND m.city = :'city'
  AND m.deal_type = :'deal_type';

\echo '=== secondary count: country + city + deal + owner ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
SELECT COUNT(*)::int AS count
FROM listing_public_feed_members AS m
WHERE m.is_canonical
  AND m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
  AND m.country = :'country'
  AND m.city = :'city'
  AND m.deal_type = :'deal_type'
  AND m.by_agency = FALSE;

\echo '=== city feed: mixed-currency price ceiling ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
SELECT COUNT(*)::int AS count
FROM listing_public_feed_members AS m
WHERE m.is_canonical
  AND m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
  AND m.country = :'country'
  AND m.city = :'city'
  AND m.deal_type = :'deal_type'
  AND (
    (UPPER(m.currency) = 'USD' AND m.price IS NOT NULL AND m.price <= :max_price_usd)
    OR
    (UPPER(m.currency) = 'UZS' AND m.price IS NOT NULL AND m.price <= :max_price_uzs)
  );

\echo '=== statistics snapshot: whole-corpus aggregation ==='
-- Served from listing_statistics_snapshots by the worker refresh, never on a
-- request. Timed here to size the refresh interval, not request latency.
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE m.by_agency)::int AS agencies
FROM listing_public_feed_members AS m
WHERE m.is_canonical
  AND m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day');

\echo '=== public feed read-model indexes ==='
SELECT
  indexrelname AS index_name,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE relname = 'listing_public_feed_members'
ORDER BY idx_scan DESC, pg_relation_size(indexrelid) DESC;

ROLLBACK;
