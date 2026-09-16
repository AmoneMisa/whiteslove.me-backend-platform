-- Property cluster facts (§24) and listing lineage edges (§26).
--
-- listing_property_clusters already maps a listing to a cluster_id, and
-- migration 029 merges clusters atomically. That mapping stays authoritative;
-- what is missing is somewhere to hold per-cluster facts and the evidence
-- behind them, and somewhere to record how two listings relate.
--
-- The cluster entity therefore keys on the SAME cluster_id rather than minting
-- a second identity, so the existing trigger, dedupe_key and merge path keep
-- working untouched.

CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Cluster facts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.property_clusters (
  -- Same key as listing_property_clusters.cluster_id. Natural PK: it is what
  -- every existing consumer already joins on.
  cluster_id TEXT PRIMARY KEY,

  country VARCHAR(8),
  city TEXT,
  district TEXT,
  street TEXT,
  residence_complex TEXT,

  -- Consensus facts across the cluster's listings. Nullable throughout: §24 is
  -- explicit that exact address equality is not required, so a cluster may be
  -- confident about its rooms and area while knowing no street.
  rooms NUMERIC,
  area_sqm NUMERIC,
  floor_number NUMERIC,
  total_floors NUMERIC,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,

  -- How many listings agree, and how many contradict. Kept as counts rather
  -- than a single score so a reviewer sees the disagreement, not just a number.
  member_count INTEGER NOT NULL DEFAULT 0,
  agreeing_count INTEGER NOT NULL DEFAULT 0,
  conflicting_count INTEGER NOT NULL DEFAULT 0,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 85);

-- Cluster lookup by area, for "other listings of this property nearby".
CREATE INDEX IF NOT EXISTS property_clusters_locality_idx
  ON platform.property_clusters (country, city, district)
  WHERE city IS NOT NULL;

-- A cluster whose members disagree is what a reviewer wants to see first.
CREATE INDEX IF NOT EXISTS property_clusters_conflicting_idx
  ON platform.property_clusters (conflicting_count DESC, last_seen_at DESC)
  WHERE conflicting_count > 0;

-- ---------------------------------------------------------------------------
-- Lineage edges
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.listing_lineage (
  id BIGSERIAL PRIMARY KEY,

  -- Directed: "from" is the listing being described, "to" is what it relates
  -- to. Denormalised triples rather than listing ids, so an edge survives
  -- either side being deleted -- the relationship is itself the evidence.
  from_source VARCHAR(32) NOT NULL,
  from_country VARCHAR(8) NOT NULL,
  from_source_id TEXT NOT NULL,
  to_source VARCHAR(32) NOT NULL,
  to_country VARCHAR(8) NOT NULL,
  to_source_id TEXT NOT NULL,

  relation VARCHAR(20) NOT NULL
    CHECK (relation IN ('possible_original', 'likely_derived', 'cross_post', 'repost', 'undetermined')),

  -- Heuristic score from scoreCloneRelationship, not a probability.
  confidence INTEGER NOT NULL DEFAULT 0,
  reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  chronology VARCHAR(24),
  price_delta_pct DOUBLE PRECISION,

  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
WITH (fillfactor = 85);

-- One edge per ordered pair; re-observation updates it rather than appending.
CREATE UNIQUE INDEX IF NOT EXISTS listing_lineage_pair_idx
  ON platform.listing_lineage (from_source, from_country, from_source_id, to_source, to_country, to_source_id);

-- "What does this listing relate to" -- the read the UI and review queue make.
CREATE INDEX IF NOT EXISTS listing_lineage_from_idx
  ON platform.listing_lineage (from_source, from_country, from_source_id, relation);

-- The reverse: "what claims to derive from this listing".
CREATE INDEX IF NOT EXISTS listing_lineage_to_idx
  ON platform.listing_lineage (to_source, to_country, to_source_id, relation);

-- Review reads only the findings. undetermined and cross_post are the bulk of
-- the table and are deliberately excluded, so this index stays small.
CREATE INDEX IF NOT EXISTS listing_lineage_findings_idx
  ON platform.listing_lineage (relation, confidence DESC, last_observed_at DESC)
  WHERE relation IN ('likely_derived', 'possible_original');
