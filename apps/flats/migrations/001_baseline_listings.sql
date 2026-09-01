CREATE TABLE IF NOT EXISTS listings (
  id BIGSERIAL PRIMARY KEY,

  source VARCHAR(32) NOT NULL,
  country VARCHAR(8) NOT NULL,
  source_id TEXT NOT NULL,

  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',

  property_type VARCHAR(32),
  deal_type VARCHAR(32),

  city TEXT,
  district TEXT,
  area TEXT,
  metro TEXT,
  address TEXT,
  residence_complex TEXT,

  price DOUBLE PRECISION,
  currency VARCHAR(16),

  rooms INTEGER,
  area_sqm DOUBLE PRECISION,

  by_agency BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  active BOOLEAN NOT NULL DEFAULT TRUE,
  missed_runs INTEGER NOT NULL DEFAULT 0,

  data JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT listings_source_country_id_unique
    UNIQUE (source, country, source_id)
);

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS availability_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS availability_status VARCHAR(16),
  ADD COLUMN IF NOT EXISTS availability_reason TEXT;

CREATE INDEX IF NOT EXISTS listings_active_idx
  ON listings(active);

CREATE INDEX IF NOT EXISTS listings_country_active_idx
  ON listings(country, active);

CREATE INDEX IF NOT EXISTS listings_source_country_active_idx
  ON listings(source, country, active);

CREATE INDEX IF NOT EXISTS listings_created_at_idx
  ON listings(created_at DESC);

CREATE INDEX IF NOT EXISTS listings_last_seen_at_idx
  ON listings(last_seen_at DESC);

CREATE INDEX IF NOT EXISTS listings_city_idx
  ON listings(city);

CREATE INDEX IF NOT EXISTS listings_district_idx
  ON listings(district);

CREATE INDEX IF NOT EXISTS listings_availability_due_idx
  ON listings(active, availability_checked_at);
