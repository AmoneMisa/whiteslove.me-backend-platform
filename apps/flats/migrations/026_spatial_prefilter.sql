-- Migration 024 materializes all STORED listing scalars in one heap rewrite and
-- commits before this file starts. Build scalar/spatial access paths here so
-- the longer index-build phase does not inherit ALTER TABLE's ACCESS EXCLUSIVE
-- lock from the rewrite transaction.
--
-- These are regular transactional CREATE INDEX statements because the current
-- migration runner guarantees atomic version recording. If production table
-- size requires online CREATE INDEX CONCURRENTLY, add explicit no-transaction
-- migration support rather than weakening migration bookkeeping ad hoc.

-- Country/city are the dominant narrowing dimensions in the listing UI. Keep
-- the hot scalar indexes selective instead of encoding every possible filter
-- combination into a separate composite index.
CREATE INDEX IF NOT EXISTS listings_active_country_city_bedrooms_idx
  ON listings(country, city, bedrooms)
  WHERE active = TRUE AND bedrooms IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_active_country_city_floor_idx
  ON listings(country, city, floor_number)
  WHERE active = TRUE AND floor_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_active_country_city_total_floors_idx
  ON listings(country, city, total_floors)
  WHERE active = TRUE AND total_floors IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_active_country_city_building_year_idx
  ON listings(country, city, building_year)
  WHERE active = TRUE AND building_year IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_active_country_city_commission_idx
  ON listings(country, city, commission_percent)
  WHERE active = TRUE AND commission_percent IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_active_country_city_metro_distance_idx
  ON listings(country, city, metro_distance_m)
  WHERE active = TRUE AND metro_distance_m IS NOT NULL;

-- Bounding-box prefilters use country plus latitude as the leading range and
-- retain longitude in the same compact partial index for the remaining check.
CREATE INDEX IF NOT EXISTS listings_active_country_geo_idx
  ON listings(country, lat, lng)
  WHERE active = TRUE AND lat IS NOT NULL AND lng IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_active_geo_idx
  ON listings(lat, lng)
  WHERE active = TRUE AND lat IS NOT NULL AND lng IS NOT NULL;

ANALYZE listings;
