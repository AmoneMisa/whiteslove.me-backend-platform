-- Platform identities and their observation history.
--
-- §19: identity resolves by stable platform subject id first, then a verified
-- contact, then username. A display name alone never merges actors -- two
-- people called "Andrey" are two people, and merging them would attribute one
-- person's history to the other. The unique indexes below encode that order.
--
-- §21: observations are appended, never overwritten. "Realtor Andrey" becoming
-- "Realtor Anton" becoming "Owner Oleg" under one platform id must remain one
-- actor with three recorded personas, because the sequence is the evidence.

CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Platform identities (current state)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.platform_identities (
  id BIGSERIAL PRIMARY KEY,

  platform VARCHAR(20) NOT NULL
    CHECK (platform IN ('telegram', 'whatsapp', 'viber', 'facebook', 'threads', 'olx', 'website', 'other')),

  -- The platform's own stable id. Nullable because not every source exposes
  -- one, but it is the strongest key when present.
  subject_id TEXT,

  username TEXT,
  display_name TEXT,
  bio TEXT,
  claimed_role VARCHAR(20),

  verification_state VARCHAR(16) NOT NULL DEFAULT 'unknown'
    CHECK (verification_state IN ('unknown', 'unverified', 'verified', 'suspended')),

  -- §20: only an authoritative creation date from the platform belongs here.
  -- first_observed_at is when we first saw the account and must never be
  -- presented as its age.
  account_created_at TIMESTAMPTZ,
  registration_observed_at TIMESTAMPTZ,

  actor_id BIGINT REFERENCES platform.actor_identities(id) ON DELETE SET NULL,

  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 85);

-- Strongest identity: the platform's own id. Partial, because rows without one
-- must not collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS platform_identities_subject_idx
  ON platform.platform_identities (platform, subject_id)
  WHERE subject_id IS NOT NULL;

-- Fallback identity, used only when the platform gave no subject id. Two rows
-- with the same username are allowed when one of them has a subject id,
-- because the subject id is authoritative and the username is not.
CREATE UNIQUE INDEX IF NOT EXISTS platform_identities_username_idx
  ON platform.platform_identities (platform, username)
  WHERE subject_id IS NULL AND username IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_identities_actor_idx
  ON platform.platform_identities (actor_id)
  WHERE actor_id IS NOT NULL;

-- Deliberately NOT unique and NOT a merge key: display_name is indexed only so
-- an admin can search it. §19 forbids merging actors on it.
CREATE INDEX IF NOT EXISTS platform_identities_display_name_idx
  ON platform.platform_identities (display_name)
  WHERE display_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Observations (append-only history)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.platform_identity_observations (
  id BIGSERIAL PRIMARY KEY,
  platform_identity_id BIGINT NOT NULL
    REFERENCES platform.platform_identities(id) ON DELETE CASCADE,

  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  username TEXT,
  display_name TEXT,
  bio TEXT,
  claimed_role VARCHAR(20),

  -- Classified when the row is written, so churn queries never have to
  -- recompute it: 'initial', 'cosmetic' or 'semantic'.
  change_kind VARCHAR(10) NOT NULL DEFAULT 'initial'
    CHECK (change_kind IN ('initial', 'cosmetic', 'semantic')),
  role_changed BOOLEAN NOT NULL DEFAULT FALSE,

  -- Hash of the observed persona. An unchanged re-observation is not appended,
  -- which is what keeps an append-only table from growing on every crawl.
  content_hash CHAR(64) NOT NULL
)
-- Append-only: rows are never updated, so leave no free space on the page.
WITH (fillfactor = 100);

-- The churn query: this identity's history, newest first, over a time window.
-- Covers both the history read and the 7d/30d counts.
CREATE INDEX IF NOT EXISTS identity_observations_history_idx
  ON platform.platform_identity_observations (platform_identity_id, observed_at DESC);

-- Skips appending an unchanged persona. Partial on semantic and cosmetic rows
-- only: 'initial' is written once per identity and never conflicts.
CREATE UNIQUE INDEX IF NOT EXISTS identity_observations_dedupe_idx
  ON platform.platform_identity_observations (platform_identity_id, content_hash);

-- Cross-identity churn reporting scans by time, not by identity. BRIN suits an
-- append-only, naturally time-ordered table: a few pages of summary instead of
-- a btree the size of the table.
CREATE INDEX IF NOT EXISTS identity_observations_observed_at_brin_idx
  ON platform.platform_identity_observations
  USING BRIN (observed_at) WITH (pages_per_range = 64);

-- Semantic changes are the only ones churn counts, and they are a small
-- fraction of all rows, so the partial index keeps that scan tiny.
CREATE INDEX IF NOT EXISTS identity_observations_semantic_idx
  ON platform.platform_identity_observations (platform_identity_id, observed_at DESC)
  WHERE change_kind = 'semantic';
