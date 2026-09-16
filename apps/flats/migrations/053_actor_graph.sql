-- Actor graph (§32) and trust/risk evidence (§33).
--
-- A typed edge table rather than a graph database: the traversals this system
-- needs are one and two hops deep -- "which contacts does this actor use",
-- "which other actors use them" -- and Postgres answers those from an index
-- faster than a second datastore could be kept in sync.
--
-- §33 is the reason evidence is one table with a `polarity` rather than two:
-- risk and trust are the same kind of observation about an actor and must stay
-- independently explainable side by side. Storing trust separately would
-- invite code that reads only the risk table.

CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Graph edges
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.actor_edges (
  id BIGSERIAL PRIMARY KEY,

  from_type VARCHAR(24) NOT NULL
    CHECK (from_type IN ('actor', 'contact_point', 'platform_identity', 'source_account', 'payment_recipient', 'property_cluster', 'job_cluster', 'candidate_profile', 'listing')),
  from_id TEXT NOT NULL,

  relation VARCHAR(28) NOT NULL
    CHECK (relation IN ('posted', 'uses_contact', 'uses_platform_identity', 'lists_property', 'represents', 'recruits_for', 'likely_derived_from', 'repost_of', 'offered_alternative')),

  to_type VARCHAR(24) NOT NULL
    CHECK (to_type IN ('actor', 'contact_point', 'platform_identity', 'source_account', 'payment_recipient', 'property_cluster', 'job_cluster', 'candidate_profile', 'listing')),
  to_id TEXT NOT NULL,

  -- How many times observed, so a one-off is distinguishable from a pattern.
  observation_count INTEGER NOT NULL DEFAULT 1,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 85);

-- One edge per ordered triple; re-observation updates the count.
CREATE UNIQUE INDEX IF NOT EXISTS actor_edges_identity_idx
  ON platform.actor_edges (from_type, from_id, relation, to_type, to_id);

-- Reverse traversal: "who else points at this node". This is the hop that
-- connects rotating identities through a shared contact, and the unique index
-- above cannot serve it.
CREATE INDEX IF NOT EXISTS actor_edges_reverse_idx
  ON platform.actor_edges (to_type, to_id, relation, from_type, from_id);

-- ---------------------------------------------------------------------------
-- Actor evidence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.actor_evidence (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT NOT NULL REFERENCES platform.actor_identities(id) ON DELETE CASCADE,

  -- Risk and trust are the same kind of record, told apart by polarity, so no
  -- consumer can read one without seeing the other.
  polarity VARCHAR(8) NOT NULL CHECK (polarity IN ('risk', 'trust')),
  reason_code VARCHAR(48) NOT NULL,

  -- Which dimension it speaks to (§34), so the resolver can weigh like with
  -- like instead of summing unrelated things.
  dimension VARCHAR(28)
    CHECK (dimension IS NULL OR dimension IN ('property_reality', 'availability_credibility', 'provenance_risk', 'identity_risk', 'payment_risk', 'actor_behavior_risk')),

  -- Independent properties or accounts behind it. §31 and §30 both turn on
  -- this: repetition on one property is not independent evidence.
  independent_count INTEGER NOT NULL DEFAULT 1,

  detail JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Human decisions live here, not in a separate table, so evidence and its
  -- disposition cannot drift apart.
  review_state VARCHAR(12) NOT NULL DEFAULT 'open'
    CHECK (review_state IN ('open', 'watch', 'confirmed', 'dismissed')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,

  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 85);

-- One row per (actor, polarity, reason); re-observation updates it.
CREATE UNIQUE INDEX IF NOT EXISTS actor_evidence_identity_idx
  ON platform.actor_evidence (actor_id, polarity, reason_code);

-- The actor profile read: everything known about one actor, both polarities.
CREATE INDEX IF NOT EXISTS actor_evidence_actor_idx
  ON platform.actor_evidence (actor_id, polarity);

-- The review queue: undismissed evidence, strongest first. Partial, because
-- confirmed and dismissed rows accumulate and nobody queues them.
CREATE INDEX IF NOT EXISTS actor_evidence_queue_idx
  ON platform.actor_evidence (independent_count DESC, last_observed_at DESC)
  WHERE review_state IN ('open', 'watch');
