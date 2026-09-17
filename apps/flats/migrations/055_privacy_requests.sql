-- Data-subject requests, disputes, processing restrictions and Article 14
-- notices (§46, §47, §49).
--
-- Most people this system holds data about never gave it to us: names, phones
-- and usernames come from public advertisements. That is why these tables
-- exist before any identity or risk feature is exposed, not after.

CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Privacy requests (Articles 15-21)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.privacy_requests (
  id BIGSERIAL PRIMARY KEY,

  -- Random, unguessable, given to the requester. The numeric id is never
  -- exposed, so references cannot be enumerated.
  reference VARCHAR(32) NOT NULL,

  request_type VARCHAR(16) NOT NULL
    CHECK (request_type IN ('access', 'rectification', 'erasure', 'restriction', 'objection', 'portability', 'dispute')),

  status VARCHAR(32) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'identity_verification_required', 'in_review', 'fulfilled', 'partially_fulfilled', 'rejected_with_reason')),

  -- Where the answer goes. Kept because the request cannot be answered
  -- without it; nothing else about the requester is asked for.
  requester_email TEXT NOT NULL,

  -- Identifiers the requester says are theirs, and the subset whose control
  -- has actually been confirmed. Only verified ones ever select data: a
  -- claimed phone number is not proof of owning it.
  claimed_identifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_identifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_method VARCHAR(32),

  details TEXT,
  resolution_reason TEXT,

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Article 12(3): one month, extendable by two further months with reasons.
  due_at TIMESTAMPTZ NOT NULL,
  extension_reason TEXT,
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (status NOT IN ('partially_fulfilled', 'rejected_with_reason') OR resolution_reason IS NOT NULL)
)
WITH (fillfactor = 85);

CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_reference_idx
  ON platform.privacy_requests (reference);

-- The operator's worklist: open requests, nearest deadline first. Partial,
-- because closed requests are the bulk of the table and nobody works them.
CREATE INDEX IF NOT EXISTS privacy_requests_open_due_idx
  ON platform.privacy_requests (due_at, id)
  WHERE status IN ('received', 'identity_verification_required', 'in_review');

-- Retention runs over closed requests by closing time.
CREATE INDEX IF NOT EXISTS privacy_requests_closed_idx
  ON platform.privacy_requests (closed_at)
  WHERE closed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Disputes (§49)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.dispute_cases (
  id BIGSERIAL PRIMARY KEY,
  privacy_request_id BIGINT REFERENCES platform.privacy_requests(id) ON DELETE SET NULL,

  dispute_type VARCHAR(32) NOT NULL
    CHECK (dispute_type IN ('wrong_phone_association', 'wrong_identity_merge', 'incorrect_role', 'stale_username', 'wrong_property_association', 'incorrect_risk_evidence')),

  -- What is disputed. SET NULL rather than CASCADE: a dispute about an actor
  -- that is later split or deleted must keep its record of having happened.
  actor_id BIGINT REFERENCES platform.actor_identities(id) ON DELETE SET NULL,
  contact_point_id BIGINT REFERENCES platform.contact_points(id) ON DELETE SET NULL,
  evidence_id BIGINT REFERENCES platform.actor_evidence(id) ON DELETE SET NULL,
  property_cluster_id BIGINT,

  -- A dispute is neither automatic erasure nor ignored: it is open until a
  -- person decides, and the decision is recorded with its reason.
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_review', 'upheld', 'partially_upheld', 'rejected')),
  statement TEXT,
  resolution_note TEXT,
  resolved_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,

  CHECK (status IN ('open', 'in_review') OR (resolution_note IS NOT NULL AND resolved_by IS NOT NULL))
)
WITH (fillfactor = 85);

CREATE INDEX IF NOT EXISTS dispute_cases_open_idx
  ON platform.dispute_cases (created_at, id)
  WHERE status IN ('open', 'in_review');

-- "Is anything about this actor or evidence under dispute": asked on every
-- public-state and high-impact decision, so it must be an index probe.
CREATE INDEX IF NOT EXISTS dispute_cases_actor_open_idx
  ON platform.dispute_cases (actor_id)
  WHERE actor_id IS NOT NULL AND status IN ('open', 'in_review');
CREATE INDEX IF NOT EXISTS dispute_cases_evidence_open_idx
  ON platform.dispute_cases (evidence_id)
  WHERE evidence_id IS NOT NULL AND status IN ('open', 'in_review');

-- ---------------------------------------------------------------------------
-- Restriction and objection (Articles 18 and 21)
-- ---------------------------------------------------------------------------

-- Columns on the existing tables rather than a side table: every read that
-- must honour a restriction already has the row in hand, so the check costs
-- nothing, where a side table would add a join to every identity read.
ALTER TABLE platform.actor_identities
  ADD COLUMN IF NOT EXISTS processing_restricted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_objection_at TIMESTAMPTZ;
ALTER TABLE platform.contact_points
  ADD COLUMN IF NOT EXISTS processing_restricted_at TIMESTAMPTZ;

-- Few rows are ever restricted; partial indexes keep these tiny.
CREATE INDEX IF NOT EXISTS actor_identities_restricted_idx
  ON platform.actor_identities (id)
  WHERE processing_restricted_at IS NOT NULL OR processing_objection_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_points_restricted_idx
  ON platform.contact_points (id)
  WHERE processing_restricted_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Article 14 notices (§46)
-- ---------------------------------------------------------------------------

-- A worklist, not a sender. Nothing here sends a message: the no-automatic-
-- messaging rule applies, and whether an exemption applies is a legal
-- question, so the default state is pending legal review rather than an
-- assumed disproportionate-effort exemption.
CREATE TABLE IF NOT EXISTS platform.article14_notices (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT NOT NULL REFERENCES platform.actor_identities(id) ON DELETE CASCADE,

  status VARCHAR(24) NOT NULL DEFAULT 'pending_legal_review'
    CHECK (status IN ('pending_legal_review', 'to_send', 'sent', 'exemption_documented', 'not_contactable')),
  channel VARCHAR(16),
  exemption_reasoning TEXT,
  handled_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,

  CHECK (status <> 'exemption_documented' OR exemption_reasoning IS NOT NULL)
)
WITH (fillfactor = 85);

CREATE UNIQUE INDEX IF NOT EXISTS article14_notices_actor_idx
  ON platform.article14_notices (actor_id);

-- ---------------------------------------------------------------------------
-- Audit subjects
-- ---------------------------------------------------------------------------

ALTER TABLE platform.review_audit_events
  DROP CONSTRAINT IF EXISTS review_audit_events_subject_type_check,
  ADD CONSTRAINT review_audit_events_subject_type_check
    CHECK (subject_type IN ('actor_evidence', 'listing', 'actor', 'contact_point', 'job_cluster', 'candidate_profile', 'privacy_request', 'dispute_case', 'article14_notice'));
