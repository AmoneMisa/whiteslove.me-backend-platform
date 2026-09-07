CREATE TABLE IF NOT EXISTS geo_city_snapshots (
  country VARCHAR(8) NOT NULL,
  city TEXT NOT NULL,
  locale VARCHAR(16) NOT NULL DEFAULT '',
  payload JSONB NOT NULL,
  source_hash VARCHAR(64) NOT NULL,
  built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (country, city, locale)
);

CREATE INDEX IF NOT EXISTS geo_city_snapshots_country_locale_idx
  ON geo_city_snapshots(country, locale, city);
