-- The public feed commonly filters only by country (and optionally source) and
-- orders by recency. The older composite indexes start with city/deal_type, so
-- those requests cannot efficiently use their created_at ordering prefix.
CREATE INDEX IF NOT EXISTS listings_active_country_created_idx
  ON listings(country, created_at DESC, id DESC)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_active_country_source_created_idx
  ON listings(country, source, created_at DESC, id DESC)
  WHERE active = TRUE;
