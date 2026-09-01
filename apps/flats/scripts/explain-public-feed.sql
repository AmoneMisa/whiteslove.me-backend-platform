-- Read-only EXPLAIN harness for the structured public feed.
-- Run on production with psql after representative traffic has warmed the cache:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/scripts/explain-public-feed.sql
--
-- The defaults reproduce the Tashkent long-rent paths that dominate UI traffic.
-- Change the psql variables below for other markets.

\set country 'UZ'
\set city 'Tashkent'
\set deal_type 'longRent'
\set max_price_usd 1000
\set max_price_uzs 12500000

BEGIN;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '2s';

\echo '=== fallback: country + deal type ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
WITH deduped AS MATERIALIZED (
  SELECT DISTINCT ON (m.dedupe_key)
    m.listing_id AS db_id,
    m.created_at
  FROM listing_public_feed_members m
  WHERE m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
    AND m.country = :'country'
    AND m.deal_type = :'deal_type'
  ORDER BY m.dedupe_key, m.created_at DESC NULLS LAST, m.listing_id DESC
),
page AS MATERIALIZED (
  SELECT d.db_id, d.created_at
  FROM deduped d
  ORDER BY d.created_at DESC NULLS LAST, d.db_id DESC
  LIMIT 21
)
SELECT totals.count, p.db_id, p.created_at, l.data
FROM (SELECT COUNT(*)::int AS count FROM deduped) totals
LEFT JOIN page p ON TRUE
LEFT JOIN listings l ON l.id = p.db_id
ORDER BY p.created_at DESC NULLS LAST, p.db_id DESC;

\echo '=== primary: country + city + deal type ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
WITH deduped AS MATERIALIZED (
  SELECT DISTINCT ON (m.dedupe_key)
    m.listing_id AS db_id,
    m.created_at
  FROM listing_public_feed_members m
  WHERE m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
    AND m.country = :'country'
    AND m.city = :'city'
    AND m.deal_type = :'deal_type'
  ORDER BY m.dedupe_key, m.created_at DESC NULLS LAST, m.listing_id DESC
)
SELECT COUNT(*)::int AS count
FROM deduped;

\echo '=== secondary: country + city + deal + owner ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
WITH deduped AS MATERIALIZED (
  SELECT DISTINCT ON (m.dedupe_key)
    m.listing_id AS db_id,
    m.created_at
  FROM listing_public_feed_members m
  WHERE m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
    AND m.country = :'country'
    AND m.city = :'city'
    AND m.deal_type = :'deal_type'
    AND m.by_agency = FALSE
  ORDER BY m.dedupe_key, m.created_at DESC NULLS LAST, m.listing_id DESC
)
SELECT COUNT(*)::int AS count
FROM deduped;

\echo '=== city feed: mixed-currency price ceiling ==='
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY, TIMING OFF)
WITH deduped AS MATERIALIZED (
  SELECT DISTINCT ON (m.dedupe_key)
    m.listing_id AS db_id,
    m.created_at
  FROM listing_public_feed_members m
  WHERE m.freshness_at >= NOW() - (14::double precision * INTERVAL '1 day')
    AND m.country = :'country'
    AND m.city = :'city'
    AND m.deal_type = :'deal_type'
    AND (
      (UPPER(m.currency) = 'USD' AND m.price IS NOT NULL AND m.price <= :max_price_usd)
      OR
      (UPPER(m.currency) = 'UZS' AND m.price IS NOT NULL AND m.price <= :max_price_uzs)
    )
  ORDER BY m.dedupe_key, m.created_at DESC NULLS LAST, m.listing_id DESC
)
SELECT COUNT(*)::int AS count
FROM deduped;

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
