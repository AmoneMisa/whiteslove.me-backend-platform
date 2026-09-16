-- Unified actor identity and contact points.
--
-- Schema ownership: `platform`, because §14 makes this explicitly shared
-- between housing, jobs and CV. `platform` already exists in
-- db/init/001-domain-schemas.sql and was unused until now. The flats migration
-- runner applies it because that is the only runner that exists; the tables are
-- schema-qualified so ownership does not depend on a search path.
--
-- Contacts are NOT newly collected here. normalize-legacy.js already parses a
-- contact out of listing text and stores it in listings.data; this promotes
-- that existing value into a queryable shape. The JSONB path stays intact
-- because migration 019's dedupe_key function reads p_data->>'phone' directly.
--
-- Performance notes are inline. The rule applied throughout: every index has a
-- query that needs it, because each one is paid for on every write.

-- db/init only runs on a fresh cluster, so an existing database would not have
-- the schema. Creating it here keeps the migration self-sufficient.
CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Contact points
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.contact_points (
  id BIGSERIAL PRIMARY KEY,

  type VARCHAR(16) NOT NULL
    CHECK (type IN ('phone', 'email', 'telegram', 'whatsapp', 'viber', 'facebook', 'threads')),

  -- Normalised once, at write time: E.164 for phones, lowercased for the rest.
  -- Never normalise in a predicate -- LOWER(canonical_value) in a WHERE would
  -- make the unique index below unusable and force a sequential scan.
  canonical_value TEXT NOT NULL,
  -- §11: the original spelling is kept alongside the canonical form.
  raw_value TEXT,

  -- "linkable" is not "verified" (§15). Nothing may infer presence on a
  -- messenger from a phone number alone.
  availability VARCHAR(16) NOT NULL DEFAULT 'declared'
    CHECK (availability IN ('declared', 'linkable', 'resolved', 'interacted', 'unavailable', 'unknown')),

  -- Article 14 provenance. Recorded from the start rather than retrofitted:
  -- these values are obtained indirectly and the obligation is already live.
  origin VARCHAR(24) NOT NULL DEFAULT 'listing_text'
    CHECK (origin IN ('listing_text', 'source_field', 'source_profile', 'legacy_registry', 'user_report', 'operator')),
  publicly_accessible BOOLEAN,
  source_ref TEXT,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observation_count INTEGER NOT NULL DEFAULT 1
)
-- last_seen_at churns on every re-observation. A lower fillfactor leaves room
-- on the page for HOT updates, which keeps those writes off the indexes.
WITH (fillfactor = 85);

-- The hot path: resolve a parsed contact to its row. Also what ON CONFLICT
-- needs. Covers lookups by (type, value) and by type alone.
CREATE UNIQUE INDEX IF NOT EXISTS contact_points_identity_idx
  ON platform.contact_points (type, canonical_value);

-- ---------------------------------------------------------------------------
-- Actor identities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.actor_identities (
  id BIGSERIAL PRIMARY KEY,

  actor_type VARCHAR(16) NOT NULL DEFAULT 'person'
    CHECK (actor_type IN ('person', 'organization')),

  -- §9: the legacy Google "Cluster ID" is a stable external key. Stored so the
  -- importer reconciles against it instead of minting a new identity per row.
  legacy_source VARCHAR(24),
  legacy_cluster_id TEXT,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 85);

-- Partial: only registry-imported actors carry a legacy id, so the index stays
-- small and the importer's reconciliation lookup stays cheap.
CREATE UNIQUE INDEX IF NOT EXISTS actor_identities_legacy_idx
  ON platform.actor_identities (legacy_source, legacy_cluster_id)
  WHERE legacy_cluster_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Actor <-> contact point
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.actor_contact_points (
  actor_id BIGINT NOT NULL REFERENCES platform.actor_identities(id) ON DELETE CASCADE,
  contact_point_id BIGINT NOT NULL REFERENCES platform.contact_points(id) ON DELETE CASCADE,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observation_count INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (actor_id, contact_point_id)
)
WITH (fillfactor = 85);

-- The reverse direction -- "which actor uses this contact" -- is the lookup
-- that turns a parsed phone into an actor, so it needs its own index. The
-- primary key only serves actor -> contacts.
CREATE INDEX IF NOT EXISTS actor_contact_points_by_contact_idx
  ON platform.actor_contact_points (contact_point_id, actor_id);

-- ---------------------------------------------------------------------------
-- Observed roles
-- ---------------------------------------------------------------------------

-- §14: roles are observations over time, not an attribute of the actor. One row
-- per (actor, role) with counts, rather than an append-only log: the questions
-- asked of it are "has this actor ever been seen as an owner" and "how often",
-- both of which an aggregate answers without scanning history.
CREATE TABLE IF NOT EXISTS platform.actor_roles (
  actor_id BIGINT NOT NULL REFERENCES platform.actor_identities(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL
    CHECK (role IN ('owner', 'realtor', 'agent', 'agency', 'candidate', 'recruiter', 'hiring_manager', 'company', 'unknown')),

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observation_count INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (actor_id, role)
)
WITH (fillfactor = 85);

-- Deliberately not indexed:
--   * contact_points.last_seen_at / first_seen_at -- no query ranges on them
--     yet, and indexing a column updated on every observation pays index
--     maintenance on every write for nothing.
--   * actor_roles.role alone -- "all owners" would be a huge unselective scan;
--     when a real query needs it, it can have a purpose-built index then.
