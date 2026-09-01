CREATE TABLE IF NOT EXISTS places (
  id BIGSERIAL PRIMARY KEY,
  country VARCHAR(8) NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  kind VARCHAR(32) NOT NULL,
  name TEXT NOT NULL,
  name_ru TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  source VARCHAR(16) NOT NULL,
  external_id TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT places_identity_unique
    UNIQUE (country, kind, source, external_id)
);

CREATE INDEX IF NOT EXISTS places_city_kind_idx
  ON places(country, city, kind);

CREATE INDEX IF NOT EXISTS places_lat_lng_idx
  ON places(lat, lng);
