-- postgres-search.js filters on LOWER(l.district) and LOWER(l.metro), but the only
-- existing indexes covering these columns (001_baseline_listings.sql, 003_search_indexes.sql)
-- are on the raw, case-sensitive columns. PostgreSQL cannot use a plain index to satisfy
-- a predicate wrapped in LOWER(), so any district- or metro-filtered feed request falls
-- back to scanning every active row for the matched country/city, which is what made
-- district-filtered searches take upwards of 20s and time out. Add expression indexes
-- that actually match the query shape, following the same pattern as 015's expression
-- indexes and 021's partial WHERE active=TRUE index.

CREATE INDEX IF NOT EXISTS listings_country_city_district_lower_idx
  ON listings (country, city, (LOWER(district)))
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_country_city_metro_lower_idx
  ON listings (country, city, (LOWER(metro)))
  WHERE active = TRUE;

ANALYZE listings;
