-- Candidate identity keys for deduplication (§38).
--
-- One row per strong identifier per candidate. Only these merge profiles:
-- names, skills, employers and education corroborate a match but are
-- deliberately absent here, so no query against this table can merge two
-- people on a shared name.
--
-- Values are normalised before insert (lowercased email, digits-only phone),
-- so the lookup index is usable; normalising in a predicate would force a
-- sequential scan.

CREATE TABLE IF NOT EXISTS {{schema}}.candidate_identity_keys (
  candidate_id BIGINT NOT NULL REFERENCES {{schema}}.candidates(id) ON DELETE CASCADE,
  key_type VARCHAR(16) NOT NULL
    CHECK (key_type IN ('email', 'phone', 'telegram_id', 'social_id')),
  key_value TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (candidate_id, key_type, key_value)
);

-- The dedupe lookup: "which other candidates hold this identifier". The primary
-- key serves candidate -> keys but not this direction.
CREATE INDEX IF NOT EXISTS candidate_identity_keys_value_idx
  ON {{schema}}.candidate_identity_keys (key_type, key_value, candidate_id);

-- The resolved person a profile belongs to. Nullable: an unmatched profile is
-- its own person, and a merge is recorded rather than rows being deleted, so a
-- wrong merge can be split again.
ALTER TABLE {{schema}}.candidates
  ADD COLUMN IF NOT EXISTS person_key TEXT;

CREATE INDEX IF NOT EXISTS candidates_person_key_idx
  ON {{schema}}.candidates (person_key)
  WHERE person_key IS NOT NULL;
