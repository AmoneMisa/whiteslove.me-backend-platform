CREATE TABLE IF NOT EXISTS {{schema}}.candidates (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(32) NOT NULL,
  country VARCHAR(8) NOT NULL,
  source_id TEXT NOT NULL,
  source_handle TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  city TEXT,
  district TEXT,
  remote BOOLEAN,
  experience_years DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT candidates_source_country_id_unique UNIQUE (source, country, source_id)
);

CREATE TABLE IF NOT EXISTS {{schema}}.source_runs (
  source VARCHAR(32) NOT NULL,
  handle TEXT NOT NULL,
  country VARCHAR(8) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, handle)
);

ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS public_id BIGINT;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS canonical_city TEXT;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS activity_at TIMESTAMPTZ;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS age SMALLINT;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS salary_min_usd DOUBLE PRECISION;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS salary_max_usd DOUBLE PRECISION;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS seniority TEXT;
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS professions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS sectors TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS skills TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';
ALTER TABLE {{schema}}.candidates ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE INDEX IF NOT EXISTS candidates_active_created_idx
  ON {{schema}}.candidates(active, created_at DESC);
CREATE INDEX IF NOT EXISTS candidates_country_created_idx
  ON {{schema}}.candidates(country, created_at DESC);
CREATE INDEX IF NOT EXISTS candidates_handle_idx
  ON {{schema}}.candidates(source_handle);
CREATE INDEX IF NOT EXISTS candidates_data_gin_idx
  ON {{schema}}.candidates USING GIN(data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS candidates_public_id_idx
  ON {{schema}}.candidates(public_id) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS candidates_active_activity_idx
  ON {{schema}}.candidates(activity_at DESC, id DESC) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS candidates_city_lower_idx
  ON {{schema}}.candidates((LOWER(canonical_city)), activity_at DESC) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS candidates_professions_gin_idx
  ON {{schema}}.candidates USING GIN(professions);
CREATE INDEX IF NOT EXISTS candidates_skills_gin_idx
  ON {{schema}}.candidates USING GIN(skills);
CREATE INDEX IF NOT EXISTS candidates_languages_gin_idx
  ON {{schema}}.candidates USING GIN(languages);
CREATE INDEX IF NOT EXISTS candidates_search_idx
  ON {{schema}}.candidates USING GIN(to_tsvector('simple', search_text));
CREATE INDEX IF NOT EXISTS candidates_dedupe_idx
  ON {{schema}}.candidates(dedupe_key, created_at DESC, id DESC) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS {{schema}}.candidate_current (
  dedupe_key TEXT PRIMARY KEY,
  candidate_id BIGINT NOT NULL UNIQUE
    REFERENCES {{schema}}.candidates(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS candidate_current_candidate_idx
  ON {{schema}}.candidate_current(candidate_id);
