CREATE TABLE IF NOT EXISTS learned_geo (
  lookup_key TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  region TEXT,
  city TEXT,
  district TEXT,
  street TEXT,
  house_number TEXT,
  building TEXT,
  entity_type TEXT NOT NULL,
  canonical_name TEXT,
  query_text TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy_m INTEGER,
  provider TEXT NOT NULL DEFAULT 'nominatim',
  provider_id TEXT,
  provider_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exported_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_learned_geo_export_pending
  ON learned_geo (created_at)
  WHERE exported_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_learned_geo_country_city
  ON learned_geo (country, city);

ALTER TABLE learned_geo
  ADD CONSTRAINT learned_geo_lat_range CHECK (lat BETWEEN -90 AND 90),
  ADD CONSTRAINT learned_geo_lng_range CHECK (lng BETWEEN -180 AND 180);
