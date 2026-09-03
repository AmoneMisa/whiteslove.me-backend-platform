-- Persist the computed statistics snapshot so serving it never runs the
-- aggregation.
--
-- The snapshot is a whole-corpus aggregation: percentiles per deal type, price
-- bands, geography rollups and a daily activity series. It was cached only in
-- each API process's memory, which meant every replica computed its own copy,
-- every restart or deploy threw them away, and whichever user request happened
-- to arrive after the TTL expired paid for the recompute.
--
-- Storing it here makes the refresh a background job (the worker owns the
-- schedule) and turns /api/statistics into a single-row read shared by every
-- replica and preserved across restarts.

CREATE TABLE IF NOT EXISTS listing_statistics_snapshots (
  -- Countries + age window the payload was computed for; 'global' is the whole
  -- catalogue over the default window that the apps request.
  scope TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  max_age_days INTEGER NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ANALYZE listing_statistics_snapshots;
