CREATE TABLE IF NOT EXISTS {{schema}}.tasks (
  id BIGSERIAL PRIMARY KEY,
  task_key TEXT NOT NULL UNIQUE,
  generation TEXT NOT NULL,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  lock_token UUID,
  locked_until TIMESTAMPTZ,
  payload JSONB NOT NULL,
  result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS {{schema}}.scheduler_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  jobs_due_at TIMESTAMPTZ,
  hiring_due_at TIMESTAMPTZ,
  backfill_due_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO {{schema}}.scheduler_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS tasks_pending_idx
  ON {{schema}}.tasks(priority DESC, run_after, created_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS tasks_running_lease_idx
  ON {{schema}}.tasks(locked_until, id)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS tasks_type_status_idx
  ON {{schema}}.tasks(type, status, created_at);
