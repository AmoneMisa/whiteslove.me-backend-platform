CREATE TABLE IF NOT EXISTS crawl_task_runs (
  task_key TEXT PRIMARY KEY,
  crawl_generation TEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  lock_token UUID,
  locked_until TIMESTAMPTZ,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crawl_task_runs_expiry_idx
  ON crawl_task_runs(updated_at);
