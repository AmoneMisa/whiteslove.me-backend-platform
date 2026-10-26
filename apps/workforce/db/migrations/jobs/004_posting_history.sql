-- Capture observed changes; lastSeen-only updates never produce history.
ALTER TABLE {{schema}}.vacancies ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE TABLE IF NOT EXISTS {{schema}}.posting_history (
  id BIGSERIAL PRIMARY KEY,
  identity_key TEXT NOT NULL REFERENCES {{schema}}.vacancies(identity_key) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind TEXT NOT NULL,
  source_published_at TIMESTAMPTZ,
  salary TEXT
);
CREATE INDEX IF NOT EXISTS posting_history_posting_idx ON {{schema}}.posting_history(identity_key, id DESC);
CREATE OR REPLACE FUNCTION {{schema}}.capture_posting_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO {{schema}}.posting_history(identity_key, kind, source_published_at)
      VALUES (NEW.identity_key, 'first_seen', NEW.posted_at);
    RETURN NEW;
  END IF;
  IF NEW.posted_at IS DISTINCT FROM OLD.posted_at THEN
    INSERT INTO {{schema}}.posting_history(identity_key, kind, source_published_at)
      VALUES (NEW.identity_key, 'date_updated', NEW.posted_at);
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    INSERT INTO {{schema}}.posting_history(identity_key, kind)
      VALUES (NEW.identity_key, CASE WHEN NEW.active THEN 'reappeared' ELSE 'removed' END);
  END IF;
  IF (NEW.data->'salaryMin', NEW.data->'salaryMax', NEW.data->'salaryCurrency', NEW.data->'salaryPeriod', NEW.data->'salary')
    IS DISTINCT FROM (OLD.data->'salaryMin', OLD.data->'salaryMax', OLD.data->'salaryCurrency', OLD.data->'salaryPeriod', OLD.data->'salary') THEN
    INSERT INTO {{schema}}.posting_history(identity_key, kind, salary)
      VALUES (NEW.identity_key, 'salary_changed', concat_ws(' ', NEW.data->>'salaryMin', NEW.data->>'salaryMax', NEW.data->>'salaryCurrency', NEW.data->>'salaryPeriod', NEW.data->>'salary'));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS vacancies_capture_history ON {{schema}}.vacancies;
CREATE TRIGGER vacancies_capture_history AFTER INSERT OR UPDATE ON {{schema}}.vacancies
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.capture_posting_history();
