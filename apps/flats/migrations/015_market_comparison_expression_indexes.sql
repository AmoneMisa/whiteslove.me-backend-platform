-- Match the actual predicates used by market-comparison.js.
-- The older 009 indexes use raw country/city/district/deal_type/created_at,
-- while the query intentionally normalizes those values and derives roomRent
-- from JSONB. PostgreSQL cannot efficiently use the raw indexes for those
-- expression predicates, so public-feed enrichment can degrade into scans of
-- the wide listings heap.

CREATE INDEX IF NOT EXISTS listings_market_rooms_expr_idx
  ON listings (
    (UPPER(country)),
    (LOWER(BTRIM(COALESCE(city, '')))),
    property_type,
    ((CASE WHEN data @> '{"roomOnly":true}'::jsonb THEN 'roomRent' ELSE deal_type END)),
    rooms,
    (LOWER(BTRIM(COALESCE(district, '')))),
    (COALESCE(created_at, first_seen_at)) DESC,
    dedupe_key,
    id DESC
  )
  INCLUDE (price, currency, created_at)
  WHERE active = TRUE
    AND price IS NOT NULL
    AND NOT (data @> '{"commercial":true}'::jsonb);

CREATE INDEX IF NOT EXISTS listings_market_area_expr_idx
  ON listings (
    (UPPER(country)),
    (LOWER(BTRIM(COALESCE(city, '')))),
    property_type,
    ((CASE WHEN data @> '{"roomOnly":true}'::jsonb THEN 'roomRent' ELSE deal_type END)),
    area_sqm,
    (LOWER(BTRIM(COALESCE(district, '')))),
    (COALESCE(created_at, first_seen_at)) DESC,
    dedupe_key,
    id DESC
  )
  INCLUDE (price, currency, created_at)
  WHERE active = TRUE
    AND price IS NOT NULL
    AND NOT (data @> '{"commercial":true}'::jsonb);

ANALYZE listings;
