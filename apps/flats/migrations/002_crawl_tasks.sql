CREATE TABLE IF NOT EXISTS crawl_tasks (
  id BIGSERIAL PRIMARY KEY,
  task_key TEXT NOT NULL UNIQUE,
  crawl_generation TEXT NOT NULL,
  type TEXT NOT NULL,
  country TEXT NOT NULL,
  crawler_shard INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  lock_token TEXT,
  locked_until TIMESTAMPTZ,
  payload JSONB NOT NULL,
  result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crawl_tasks_pending_idx
  ON crawl_tasks (
    type,
    crawler_shard,
    priority DESC,
    run_after,
    created_at,
    id
  )
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS crawl_tasks_running_lease_idx
  ON crawl_tasks (locked_until, id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS crawl_tasks_generation_idx
  ON crawl_tasks (crawl_generation, status, created_at);
