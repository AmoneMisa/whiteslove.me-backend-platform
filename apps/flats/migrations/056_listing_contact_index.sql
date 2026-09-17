-- Listing lines: "this contact has other listings" (purple line).
--
-- The feed asks, for one page of contacts, how many other distinct properties
-- each contact advertises. Without an index that is a scan of every active
-- listing per page. Expression index on the stored contact, partial on active
-- listings (the only ones the question is about), with dedupe_key included so
-- count(DISTINCT dedupe_key) is answered by an index-only scan.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the runner wraps each migration in a
-- transaction, where CONCURRENTLY is not allowed. The build takes a brief
-- write lock on listings once, at deploy.

CREATE INDEX IF NOT EXISTS listings_active_contact_idx
  ON listings ((data->>'contact'))
  INCLUDE (dedupe_key)
  WHERE active = TRUE AND data->>'contact' IS NOT NULL;
