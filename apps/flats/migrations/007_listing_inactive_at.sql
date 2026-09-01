ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS inactive_at TIMESTAMPTZ;

UPDATE listings
SET inactive_at = COALESCE(inactive_at, availability_checked_at, updated_at)
WHERE active = FALSE
  AND inactive_at IS NULL;

CREATE INDEX IF NOT EXISTS listings_inactive_at_idx
  ON listings(inactive_at DESC)
  WHERE active = FALSE;
