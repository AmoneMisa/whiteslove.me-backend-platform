CREATE INDEX IF NOT EXISTS listings_feed_newest_idx
  ON listings(country, city, deal_type, created_at DESC, id DESC)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_feed_price_idx
  ON listings(country, city, deal_type, currency, price, id)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_feed_district_idx
  ON listings(country, city, district, deal_type, created_at DESC, id DESC)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_feed_rooms_idx
  ON listings(country, city, deal_type, rooms, created_at DESC, id DESC)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_feed_area_idx
  ON listings(country, city, deal_type, area_sqm, created_at DESC, id DESC)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_feed_title_idx
  ON listings(country, city, deal_type, LOWER(title), id)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_active_data_gin_idx
  ON listings USING GIN(data jsonb_path_ops)
  WHERE active = TRUE;
