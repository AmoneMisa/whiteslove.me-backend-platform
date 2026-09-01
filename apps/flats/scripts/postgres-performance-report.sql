-- Flat Finder production performance report.
-- Run against the production database after representative traffic has warmed
-- pg_stat_statements. This script is read-only and still reports index/table,
-- relation-size, vacuum, and database IO pressure when pg_stat_statements is
-- unavailable.

\echo '=== database / connection summary ==='
SELECT
  current_database() AS database,
  current_setting('server_version') AS server_version,
  current_setting('max_connections')::integer AS max_connections,
  COUNT(*) AS current_connections,
  COUNT(*) FILTER (WHERE state = 'active') AS active_connections,
  COUNT(*) FILTER (WHERE wait_event IS NOT NULL) AS waiting_connections
FROM pg_stat_activity
WHERE datname = current_database();

\echo '=== database IO / statistics window ==='
SELECT
  datname,
  numbackends,
  xact_commit,
  xact_rollback,
  blks_read,
  blks_hit,
  ROUND(
    100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0),
    2
  ) AS cache_hit_pct,
  temp_files,
  pg_size_pretty(temp_bytes) AS temp_bytes,
  deadlocks,
  stats_reset
FROM pg_stat_database
WHERE datname = current_database();

SELECT EXISTS (
  SELECT 1
  FROM pg_extension
  WHERE extname = 'pg_stat_statements'
) AS has_pg_stat_statements
\gset

\echo '=== pg_stat_statements configuration ==='
SELECT
  :'has_pg_stat_statements'::boolean AS extension_installed,
  current_setting('shared_preload_libraries') AS shared_preload_libraries;

\if :has_pg_stat_statements
\echo '=== top statements by total execution time ==='
SELECT
  calls,
  ROUND(total_exec_time::numeric, 2) AS total_ms,
  ROUND(mean_exec_time::numeric, 2) AS mean_ms,
  ROUND(max_exec_time::numeric, 2) AS max_ms,
  rows,
  shared_blks_hit,
  shared_blks_read,
  temp_blks_written,
  LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 500) AS query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT 30;

\echo '=== top statements by mean execution time (minimum 20 calls) ==='
SELECT
  calls,
  ROUND(mean_exec_time::numeric, 2) AS mean_ms,
  ROUND(max_exec_time::numeric, 2) AS max_ms,
  rows,
  shared_blks_hit,
  shared_blks_read,
  temp_blks_written,
  LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 500) AS query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND calls >= 20
ORDER BY mean_exec_time DESC
LIMIT 30;
\else
\echo '=== pg_stat_statements unavailable ==='
\echo 'Enable/load pg_stat_statements to collect statement timing; continuing with relation/index/table statistics.'
\endif

\echo '=== largest user relations / TOAST ==='
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  pg_size_pretty(pg_relation_size(c.oid)) AS heap_size,
  pg_size_pretty(pg_indexes_size(c.oid)) AS indexes_size,
  pg_size_pretty(
    CASE
      WHEN c.reltoastrelid <> 0 THEN pg_total_relation_size(c.reltoastrelid)
      ELSE 0
    END
  ) AS toast_size,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 30;

\echo '=== listing indexes by scan count / size ==='
SELECT
  s.schemaname,
  s.relname AS table_name,
  s.indexrelname AS index_name,
  s.idx_scan,
  s.idx_tup_read,
  s.idx_tup_fetch,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size
FROM pg_stat_user_indexes s
WHERE s.relname IN (
  'listings',
  'listing_public_feed_members',
  'listing_location_terms',
  'listing_nearby_places',
  'listing_photo_hashes',
  'listing_property_clusters',
  'crawl_tasks'
)
ORDER BY s.relname, s.idx_scan DESC, pg_relation_size(s.indexrelid) DESC;

\echo '=== table IO / vacuum / dead tuple pressure ==='
SELECT
  schemaname,
  relname,
  seq_scan,
  idx_scan,
  n_live_tup,
  n_dead_tup,
  ROUND(
    100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0),
    2
  ) AS dead_pct,
  n_tup_ins,
  n_tup_upd,
  n_tup_del,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze,
  vacuum_count,
  autovacuum_count,
  analyze_count,
  autoanalyze_count
FROM pg_stat_user_tables
WHERE (schemaname = 'public' AND relname IN (
  'listings',
  'listing_public_feed_members',
  'listing_location_terms',
  'listing_nearby_places',
  'listing_photo_hashes',
  'listing_property_clusters',
  'crawl_tasks'
)) OR (schemaname = 'subscriptions' AND relname IN (
  'mobile_deliveries',
  'mobile_subscription_seen'
))
ORDER BY n_dead_tup DESC;

\echo '=== queue backlog / leases ==='
SELECT
  status,
  COUNT(*) AS tasks,
  MIN(run_after) AS oldest_run_after,
  MIN(locked_until) FILTER (WHERE status = 'running') AS earliest_lease_expiry
FROM crawl_tasks
GROUP BY status
ORDER BY status;

\echo '=== mobile delivery outbox ==='
SELECT
  status,
  COUNT(*) AS deliveries,
  MIN(updated_at) AS oldest_updated_at,
  MAX(attempts) AS max_attempts
FROM subscriptions.mobile_deliveries
GROUP BY status
ORDER BY status;
