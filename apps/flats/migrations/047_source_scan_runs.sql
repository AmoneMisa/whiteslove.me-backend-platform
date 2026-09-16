-- Scan confidence lifecycle.
--
-- Reconciliation used to trust any chain that terminated normally, so a source
-- returning well-formed empty pages (maintenance, anti-bot, rate limiting)
-- could deactivate an entire scope's inventory in one run. Recording each
-- finished scan lets a suspect empty result be distinguished from a confirmed
-- one: only repeated, independent, otherwise-reliable empty scans may remove
-- inventory.

CREATE TABLE IF NOT EXISTS source_scan_runs (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  country TEXT NOT NULL,
  -- Free-form scope key (e.g. an OLX segment), so one source can be scanned in
  -- independently reconciled slices.
  scope TEXT NOT NULL DEFAULT '',
  crawl_generation TEXT,
  state TEXT NOT NULL
    CHECK (state IN ('complete', 'partial', 'failed', 'suspect-empty', 'confirmed-empty')),
  reason TEXT,
  observed_count INTEGER NOT NULL DEFAULT 0,
  known_active_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  deactivated_count INTEGER NOT NULL DEFAULT 0,
  empty_streak INTEGER NOT NULL DEFAULT 0,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The streak query: most recent runs for one scope, newest first.
CREATE INDEX IF NOT EXISTS source_scan_runs_scope_idx
  ON source_scan_runs (source, country, scope, observed_at DESC);

-- One row per generation per scope, so a retried task cannot inflate a streak.
CREATE UNIQUE INDEX IF NOT EXISTS source_scan_runs_generation_idx
  ON source_scan_runs (source, country, scope, crawl_generation)
  WHERE crawl_generation IS NOT NULL;
