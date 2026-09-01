CREATE TABLE IF NOT EXISTS {{schema}}.vacancies (
  identity_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  public_id BIGINT,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  country TEXT,
  city TEXT,
  posted_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  remote BOOLEAN,
  work_mode TEXT,
  relocation TEXT,
  employment_kind TEXT,
  salary_usd DOUBLE PRECISION,
  experience_min_years DOUBLE PRECISION,
  foreigner_friendly BOOLEAN NOT NULL DEFAULT FALSE,
  usa_foreigner_friendly BOOLEAN NOT NULL DEFAULT FALSE,
  no_experience BOOLEAN NOT NULL DEFAULT FALSE,
  risk_category TEXT,
  profession TEXT NOT NULL DEFAULT 'Other',
  languages JSONB NOT NULL DEFAULT '[]'::jsonb,
  language_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  skills TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  search_text TEXT NOT NULL DEFAULT '',
  sync_token TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE {{schema}}.vacancies
  ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS vacancies_source_id_idx
  ON {{schema}}.vacancies(source, source_id);
CREATE INDEX IF NOT EXISTS vacancies_public_id_idx
  ON {{schema}}.vacancies(public_id) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS vacancies_active_posted_idx
  ON {{schema}}.vacancies(posted_at DESC, identity_key) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS vacancies_country_posted_idx
  ON {{schema}}.vacancies(country, posted_at DESC) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS vacancies_source_posted_idx
  ON {{schema}}.vacancies(source, posted_at DESC) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS vacancies_city_lower_idx
  ON {{schema}}.vacancies((LOWER(city)), posted_at DESC) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS vacancies_work_mode_idx
  ON {{schema}}.vacancies(work_mode, posted_at DESC) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS vacancies_salary_idx
  ON {{schema}}.vacancies(salary_usd DESC)
  WHERE active = TRUE AND salary_usd IS NOT NULL;
CREATE INDEX IF NOT EXISTS vacancies_skills_gin_idx
  ON {{schema}}.vacancies USING GIN(skills);
CREATE INDEX IF NOT EXISTS vacancies_language_keys_gin_idx
  ON {{schema}}.vacancies USING GIN(language_keys);
CREATE INDEX IF NOT EXISTS vacancies_data_gin_idx
  ON {{schema}}.vacancies USING GIN(data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS vacancies_search_idx
  ON {{schema}}.vacancies USING GIN(to_tsvector('simple', search_text));
