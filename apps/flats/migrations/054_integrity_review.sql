-- Human review of integrity evidence (§36).
--
-- Review decisions already live on platform.actor_evidence (053), so evidence
-- and its disposition cannot drift apart. This adds the two things 053 lacked:
-- a `resolved` state for matters that are over, and an append-only audit trail,
-- because the current state says what was decided but not who decided it, when,
-- why, or what it was before. A dispute or an access request needs all four.

-- ---------------------------------------------------------------------------
-- resolved state
-- ---------------------------------------------------------------------------

-- The migration runner wraps each file in one transaction, so the table lock
-- is held until commit whatever is done here; a NOT VALID/VALIDATE split would
-- save nothing. One statement, which validates the (young, small) table once.
-- The new constraint only widens the old one, so it cannot fail on existing rows.
ALTER TABLE platform.actor_evidence
  DROP CONSTRAINT IF EXISTS actor_evidence_review_state_check,
  ADD CONSTRAINT actor_evidence_review_state_check
    CHECK (review_state IN ('open', 'watch', 'confirmed', 'dismissed', 'resolved'));

-- Keyset pagination for the queue. The 053 index orders by strength and
-- recency but has no tiebreaker, so rows with equal values could repeat or be
-- skipped between pages; with id appended the cursor is exact and every page
-- is an index range scan, however deep the queue.
DROP INDEX IF EXISTS platform.actor_evidence_queue_idx;
CREATE INDEX IF NOT EXISTS actor_evidence_queue_keyset_idx
  ON platform.actor_evidence (independent_count DESC, last_observed_at DESC, id DESC)
  WHERE review_state IN ('open', 'watch');

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.review_audit_events (
  id BIGSERIAL PRIMARY KEY,

  subject_type VARCHAR(24) NOT NULL
    CHECK (subject_type IN ('actor_evidence', 'listing', 'actor', 'job_cluster', 'candidate_profile', 'privacy_request')),
  subject_id BIGINT NOT NULL,

  action VARCHAR(16) NOT NULL,
  from_state VARCHAR(24),
  to_state VARCHAR(24),

  -- A named person. Automated steps never write here: §36 is about the
  -- decisions only a human may take.
  reviewer TEXT NOT NULL,
  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
-- Append-only: rows are never updated, so leaving free space would only waste
-- pages.
WITH (fillfactor = 100);

-- "History of this item", newest first. id rises with time, so it orders the
-- history without a timestamp in the key.
CREATE INDEX IF NOT EXISTS review_audit_events_subject_idx
  ON platform.review_audit_events (subject_type, subject_id, id DESC);

-- Time-range scans for retention and reporting. BRIN, because rows are
-- inserted in time order and a B-tree over an append-only timestamp would be
-- orders of magnitude larger for the same pruning.
CREATE INDEX IF NOT EXISTS review_audit_events_created_brin
  ON platform.review_audit_events USING brin (created_at);
