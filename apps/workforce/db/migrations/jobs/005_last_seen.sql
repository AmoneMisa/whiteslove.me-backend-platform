-- When a posting was last seen by its source.
--
-- Until now this lived only inside the one-file vacancy snapshot (data.lastSeen), and the database copy was
-- deliberately not rewritten for a lastSeen-only change, so it was always stale. The incremental store writes the
-- vacancies of one source at a time instead of replaying the whole snapshot, and "not seen for N days" has to be
-- answered from the database. Nullable and without a default: adding it rewrites nothing, and a row that has never
-- been re-seen by the incremental store (NULL) is only ever aged out by its posting date, never by this column.
ALTER TABLE {{schema}}.vacancies
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Staleness is checked for live postings only, which is a small slice of the table.
CREATE INDEX IF NOT EXISTS vacancies_active_last_seen_idx
  ON {{schema}}.vacancies (last_seen_at)
  WHERE active = TRUE AND last_seen_at IS NOT NULL;
