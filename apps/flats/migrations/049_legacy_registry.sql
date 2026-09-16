-- Legacy realtor registry, imported read-only from the existing
-- "Flat Finder Internal Registry" Google Sheet.
--
-- §9: "Cluster ID" is a stable external key. It is stored as the reconciliation
-- key so a rerun updates the same rows instead of minting a new identity per
-- import.
--
-- §10: risk, trust and review evidence are kept independent. Collapsing them
-- into one blacklist is the failure this schema exists to prevent -- a cluster
-- can legitimately carry both a risk note and a trusted note, and the two must
-- remain separately explainable.
--
-- §35: everything here is INTERNAL. A "hard blacklist" or "high risk" label is
-- a legacy operator note, not a public verdict, and nothing in this schema may
-- be exposed publicly without a separate product and legal decision. The
-- classification is stored verbatim as a legacy label for exactly that reason.

CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Clusters
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.registry_clusters (
  -- The sheet's own Cluster ID. Natural primary key on purpose: it is what the
  -- other tabs reference and what a rerun reconciles against, so a surrogate
  -- key would add a join to every lookup and buy nothing.
  cluster_id TEXT PRIMARY KEY,
  country VARCHAR(8),

  -- Which tab the row came from. A cluster present in both tabs keeps both
  -- kinds of evidence; this records where the cluster itself was defined.
  kind VARCHAR(8) NOT NULL CHECK (kind IN ('risk', 'trusted', 'both')),

  identity TEXT,
  status TEXT,
  last_updated_text TEXT,

  actor_id BIGINT REFERENCES platform.actor_identities(id) ON DELETE SET NULL,

  first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 90);

CREATE INDEX IF NOT EXISTS registry_clusters_actor_idx
  ON platform.registry_clusters (actor_id)
  WHERE actor_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Evidence (§10)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.registry_evidence (
  id BIGSERIAL PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES platform.registry_clusters(cluster_id) ON DELETE CASCADE,

  kind VARCHAR(8) NOT NULL CHECK (kind IN ('risk', 'trusted', 'review')),
  -- Verbatim legacy label ("hidden realtor/operator", "high-risk", "hard
  -- blacklist"). Deliberately free text, not an enum: normalising it would
  -- quietly turn an operator's shorthand into a system verdict.
  classification TEXT,
  evidence_text TEXT,
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  -- Stable hash of the evidence content, so a rerun updates rather than
  -- appends. This is what makes the import idempotent for a tab that has no
  -- per-row id of its own.
  content_hash CHAR(64) NOT NULL,

  first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 90);

-- The idempotency key and the "evidence for this cluster" lookup in one index.
CREATE UNIQUE INDEX IF NOT EXISTS registry_evidence_identity_idx
  ON platform.registry_evidence (cluster_id, kind, content_hash);

-- ---------------------------------------------------------------------------
-- Identifiers (§11)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.registry_identifiers (
  id BIGSERIAL PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES platform.registry_clusters(cluster_id) ON DELETE CASCADE,
  country VARCHAR(8),

  identifier_type VARCHAR(24) NOT NULL
    CHECK (identifier_type IN ('phone', 'telegram', 'name', 'organization', 'source_account', 'email', 'other')),

  -- Normalised where possible (E.164 for phones, lowercased handles), with the
  -- sheet's original spelling kept alongside it per §11.
  canonical_value TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  -- Set when the value could not be normalised, so the reconciliation report
  -- can list it instead of the importer silently dropping the row.
  normalization_error TEXT,

  classification TEXT,

  contact_point_id BIGINT REFERENCES platform.contact_points(id) ON DELETE SET NULL,

  first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 90);

CREATE UNIQUE INDEX IF NOT EXISTS registry_identifiers_identity_idx
  ON platform.registry_identifiers (cluster_id, identifier_type, canonical_value);

-- §63: the same phone may legitimately appear in several clusters, and that
-- is a conflict to report rather than merge. This index answers "which
-- clusters claim this identifier" without scanning.
CREATE INDEX IF NOT EXISTS registry_identifiers_value_idx
  ON platform.registry_identifiers (identifier_type, canonical_value);

-- ---------------------------------------------------------------------------
-- Sources (§11)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.registry_sources (
  id BIGSERIAL PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES platform.registry_clusters(cluster_id) ON DELETE CASCADE,
  country VARCHAR(8),
  classification TEXT,

  -- A real URL when the sheet gave one.
  url TEXT,
  -- Opaque legacy references such as "turn123search4" are kept as evidence but
  -- must never be treated as dereferenceable by production code.
  legacy_ref TEXT,
  note TEXT,

  content_hash CHAR(64) NOT NULL,

  first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 90);

CREATE UNIQUE INDEX IF NOT EXISTS registry_sources_identity_idx
  ON platform.registry_sources (cluster_id, content_hash);

-- ---------------------------------------------------------------------------
-- Review cases (§12)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.registry_review_cases (
  id BIGSERIAL PRIMARY KEY,

  case_type TEXT,
  country VARCHAR(8),
  subjects TEXT,
  -- Original wording preserved verbatim: it is the operator's reasoning and
  -- rewriting it would lose why the case was opened.
  reason TEXT,

  state VARCHAR(12) NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'watch', 'resolved', 'dismissed')),
  legacy_state_text TEXT,

  content_hash CHAR(64) NOT NULL,

  first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 90);

CREATE UNIQUE INDEX IF NOT EXISTS registry_review_cases_identity_idx
  ON platform.registry_review_cases (content_hash);

-- Work queue lookup: open and watched cases only, which is a small slice of
-- the table once most are resolved.
CREATE INDEX IF NOT EXISTS registry_review_cases_open_idx
  ON platform.registry_review_cases (state, country)
  WHERE state IN ('open', 'watch');

-- ---------------------------------------------------------------------------
-- Import runs (§13)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.registry_import_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  ok BOOLEAN,
  -- Counts and conflicts from the reconciliation report.
  report JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS registry_import_runs_recent_idx
  ON platform.registry_import_runs (started_at DESC);
