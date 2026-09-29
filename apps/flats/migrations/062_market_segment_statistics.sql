-- Correlated statistics for the market-comparison segment columns.
--
-- Country, city, property type and deal kind are strongly correlated (every
-- Tashkent listing is UZ, most are flats), but the planner multiplies their
-- selectivities as if independent and estimates ~1 row for any segment. With
-- both listings_market_rooms_expr_idx and listings_market_area_expr_idx
-- "costing" one row, it picked either at random, and a rooms target read its
-- whole city/deal segment through the area index, filtering rooms and district
-- row by row. Extended statistics over the same expressions the indexes use
-- give realistic estimates, so the index that also constrains rooms/area and
-- district wins.
--
-- CREATE STATISTICS and ANALYZE take SHARE UPDATE EXCLUSIVE, which does not
-- block reads or writes; an autovacuum holding it is cancelled for us. The
-- lock_timeout only guards against another manual maintenance job.
SET LOCAL lock_timeout = '5s';

CREATE STATISTICS IF NOT EXISTS listings_market_segment_stats (ndistinct, dependencies, mcv)
  ON (UPPER(country)),
     (LOWER(BTRIM(COALESCE(city, '')))),
     property_type,
     (CASE WHEN room_only THEN 'roomRent' ELSE deal_type END)
  FROM listings;

ANALYZE listings;
