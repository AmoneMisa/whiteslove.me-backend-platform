CREATE INDEX IF NOT EXISTS listings_market_rooms_idx
  ON listings(country, city, district, property_type, deal_type, rooms, created_at DESC, id DESC)
  WHERE active = TRUE AND price IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_market_area_idx
  ON listings(country, city, district, property_type, deal_type, area_sqm, created_at DESC, id DESC)
  WHERE active = TRUE AND price IS NOT NULL;
