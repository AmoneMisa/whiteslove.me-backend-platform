CREATE TABLE IF NOT EXISTS geo_city_snapshots (
  country VARCHAR(8) NOT NULL,
  city TEXT NOT NULL,
  locale VARCHAR(16) NOT NULL DEFAULT '',
  zones JSONB NOT NULL,
  source_hash VARCHAR(64) NOT NULL,
  built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (country, city, locale)
);

CREATE INDEX IF NOT EXISTS geo_city_snapshots_country_locale_idx
  ON geo_city_snapshots(country, locale, city);

CREATE TABLE IF NOT EXISTS geo_city_options (
  country VARCHAR(8) NOT NULL,
  city TEXT NOT NULL,
  locale VARCHAR(16) NOT NULL DEFAULT '',
  districts TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  district_labels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metro TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metro_labels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  microdistricts TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  microdistrict_labels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  quartals TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  quartal_labels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  areas TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  area_labels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_hash VARCHAR(64) NOT NULL,
  built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (country, city, locale),
  CHECK (cardinality(district_labels) = cardinality(districts)),
  CHECK (cardinality(metro_labels) = cardinality(metro)),
  CHECK (cardinality(microdistrict_labels) = cardinality(microdistricts)),
  CHECK (cardinality(quartal_labels) = cardinality(quartals)),
  CHECK (cardinality(area_labels) = cardinality(areas))
);

CREATE INDEX IF NOT EXISTS geo_city_options_country_locale_idx
  ON geo_city_options(country, locale, city);
