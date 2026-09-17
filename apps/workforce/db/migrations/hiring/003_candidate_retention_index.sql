-- Candidate retention: profiles are deleted six months after they were last
-- seen at their source (shared/privacy/candidateRetention.ts). The retention
-- job reads the oldest rows by last_seen_at in batches; without this index
-- every batch would scan the whole table.
CREATE INDEX IF NOT EXISTS candidates_last_seen_idx
  ON {{schema}}.candidates (last_seen_at);
