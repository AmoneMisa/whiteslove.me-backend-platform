-- Materialised listing lines (green / red / purple), for filtering and display.
--
-- Computing a line needs evidence scoring in application code, so it cannot be
-- a SQL predicate at query time. The worker computes lines per contact and
-- writes one row per active listing that has a line; listings without a line
-- have no row. That keeps the table to the small interesting subset, and lets
-- both filters be cheap:
--   "Trusted ads" -> semi-join on (line, listing_id), a tiny range of the index
--   "Hide danger" -> anti-join probe on the primary key
-- Display reads the same rows, so the line a card shows and the filter that
-- selected it can never disagree.

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.listing_lines (
  listing_id BIGINT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  line VARCHAR(16) NOT NULL
    CHECK (line IN ('steady', 'phantom_risk', 'multi_listing')),
  -- Other distinct properties (dedupe keys) the same contact advertises; drives
  -- the popup's "this contact's other listings" tab.
  other_properties INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
-- Refreshed in place every cycle; unchanged rows are skipped, changed ones
-- update without moving to a new page.
WITH (fillfactor = 85);

CREATE INDEX IF NOT EXISTS listing_lines_line_idx
  ON platform.listing_lines (line, listing_id);
