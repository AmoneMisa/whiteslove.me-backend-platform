-- Immutable listing observations (§28) and availability observations (§30).
--
-- The audit found that price, contact, content and media are overwritten in
-- place, so "reappeared", "price changed" and "contact changed" cannot be
-- reconstructed from what is stored. Lineage (§26), repost cycles (§29) and
-- bait-and-switch (§31) are all historical questions, so they need history.
--
-- The cost decision that makes this affordable: a snapshot is appended only
-- when something material changed. Writing one per crawl would add a row per
-- listing per cycle and dwarf the listings table within weeks. The content
-- hash is the gate.
--
-- The privacy decision (§52): history stores hashes and references, not copies.
-- A contact is referenced by contact_point_id, never duplicated into every
-- snapshot, so one erasure request does not have to find the same phone number
-- in a hundred thousand history rows.

CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Listing snapshots
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.listing_snapshots (
  id BIGSERIAL PRIMARY KEY,

  -- Nullable, and deliberately SET NULL rather than CASCADE: §28 keeps history
  -- for deleted listings under the retention policy, so deleting the listing
  -- must not delete the record that it existed.
  listing_id BIGINT REFERENCES listings(id) ON DELETE SET NULL,
  -- Denormalised so history survives that deletion and is still addressable.
  source VARCHAR(32) NOT NULL,
  country VARCHAR(8) NOT NULL,
  source_id TEXT NOT NULL,

  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  lifecycle_state VARCHAR(12) NOT NULL
    CHECK (lifecycle_state IN ('published', 'active', 'removed', 'reappeared')),

  price NUMERIC,
  currency VARCHAR(16),

  -- Hashes, not copies. Enough to detect that something changed and to compare
  -- two listings, without duplicating the text or the contact.
  content_hash CHAR(64),
  media_hash CHAR(64),
  contact_point_id BIGINT REFERENCES platform.contact_points(id) ON DELETE SET NULL,

  availability_status VARCHAR(20),

  -- Which aspects changed since the previous snapshot, so "when did the price
  -- change" is an index scan rather than a recomputation over the series.
  changed TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Gate for the append-only-on-change rule.
  snapshot_hash CHAR(64) NOT NULL
)
-- Append-only: rows are never updated, so leave no free space per page.
WITH (fillfactor = 100);

-- The history read: one listing, newest first. Serves lineage, repost and
-- price-change queries.
CREATE INDEX IF NOT EXISTS listing_snapshots_history_idx
  ON platform.listing_snapshots (listing_id, observed_at DESC)
  WHERE listing_id IS NOT NULL;

-- The same read for a listing whose row is gone.
CREATE INDEX IF NOT EXISTS listing_snapshots_source_history_idx
  ON platform.listing_snapshots (source, country, source_id, observed_at DESC);

-- Skips appending an unchanged snapshot. This is what keeps the table from
-- growing on every crawl.
CREATE UNIQUE INDEX IF NOT EXISTS listing_snapshots_dedupe_idx
  ON platform.listing_snapshots (source, country, source_id, snapshot_hash);

-- Cross-listing reporting scans by time. BRIN suits an append-only,
-- time-ordered table at a fraction of a btree's size.
CREATE INDEX IF NOT EXISTS listing_snapshots_observed_at_brin_idx
  ON platform.listing_snapshots USING BRIN (observed_at) WITH (pages_per_range = 64);

-- Repost detection reads only the lifecycle transitions, a small slice.
CREATE INDEX IF NOT EXISTS listing_snapshots_lifecycle_idx
  ON platform.listing_snapshots (source, country, source_id, observed_at DESC)
  WHERE lifecycle_state IN ('removed', 'reappeared');

-- Clone detection asks "which other listings share this media set". Partial,
-- because a listing with no photos answers nothing.
CREATE INDEX IF NOT EXISTS listing_snapshots_media_idx
  ON platform.listing_snapshots (media_hash)
  WHERE media_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Availability observations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform.listing_availability_observations (
  id BIGSERIAL PRIMARY KEY,

  listing_id BIGINT REFERENCES listings(id) ON DELETE SET NULL,
  source VARCHAR(32) NOT NULL,
  country VARCHAR(8) NOT NULL,
  source_id TEXT NOT NULL,

  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  status VARCHAR(24) NOT NULL
    CHECK (status IN ('available', 'viewing_available', 'reserved', 'already_rented', 'unavailable', 'offered_alternative', 'no_response')),

  -- Who observed it. A user report and an automated probe are not equally
  -- reliable and must stay distinguishable.
  observer VARCHAR(16) NOT NULL DEFAULT 'probe'
    CHECK (observer IN ('probe', 'user_report', 'source', 'operator')),

  -- §31: what was offered instead. The bait-and-switch graph is built from
  -- these edges, and independent properties matter more than repetition on one.
  alternative_listing_id BIGINT REFERENCES listings(id) ON DELETE SET NULL,
  alternative_source_id TEXT,

  -- How long after the listing was published this was observed, stored because
  -- it is the basis of freshUnavailableRate and is expensive to recompute.
  minutes_since_published INTEGER,

  note TEXT
)
WITH (fillfactor = 100);

CREATE INDEX IF NOT EXISTS availability_observations_history_idx
  ON platform.listing_availability_observations (listing_id, observed_at DESC)
  WHERE listing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS availability_observations_source_idx
  ON platform.listing_availability_observations (source, country, source_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS availability_observations_observed_at_brin_idx
  ON platform.listing_availability_observations USING BRIN (observed_at) WITH (pages_per_range = 64);

-- The actor-level question -- "how often does this contact's fresh inventory
-- turn out to be unavailable" -- reads only the negative outcomes.
CREATE INDEX IF NOT EXISTS availability_observations_negative_idx
  ON platform.listing_availability_observations (status, observed_at DESC)
  WHERE status IN ('already_rented', 'unavailable', 'offered_alternative', 'no_response');
