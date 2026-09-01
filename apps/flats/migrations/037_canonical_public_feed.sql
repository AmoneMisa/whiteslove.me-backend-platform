-- Persist the winning row for every dedupe group at write time.
-- Public reads can then filter/sort only canonical listings instead of running
-- DISTINCT ON / ROW_NUMBER over every matching request.

CREATE TABLE IF NOT EXISTS listing_public_feed_canonical (
  dedupe_key TEXT PRIMARY KEY,
  listing_id BIGINT NOT NULL
    REFERENCES listing_public_feed_members(listing_id) ON DELETE CASCADE,
  canonical_created_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS listing_public_feed_canonical_listing_idx
  ON listing_public_feed_canonical(listing_id, dedupe_key);

CREATE OR REPLACE FUNCTION refresh_listing_public_feed_canonical(p_dedupe_key TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_listing_id BIGINT;
  v_created_at TIMESTAMPTZ;
BEGIN
  IF p_dedupe_key IS NULL OR p_dedupe_key = '' THEN
    RETURN;
  END IF;

  -- Two workers can ingest the same apartment concurrently. Serialize only
  -- this dedupe group so the second transaction re-reads the committed winner
  -- instead of overwriting it from a stale snapshot.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_dedupe_key, 913744));

  SELECT m.listing_id, m.created_at
  INTO v_listing_id, v_created_at
  FROM listing_public_feed_members AS m
  WHERE m.dedupe_key = p_dedupe_key
  ORDER BY m.created_at DESC NULLS LAST, m.listing_id DESC
  LIMIT 1;

  IF v_listing_id IS NULL THEN
    DELETE FROM listing_public_feed_canonical
    WHERE dedupe_key = p_dedupe_key;
    RETURN;
  END IF;

  INSERT INTO listing_public_feed_canonical (
    dedupe_key,
    listing_id,
    canonical_created_at
  ) VALUES (
    p_dedupe_key,
    v_listing_id,
    v_created_at
  )
  ON CONFLICT (dedupe_key) DO UPDATE SET
    listing_id = EXCLUDED.listing_id,
    canonical_created_at = EXCLUDED.canonical_created_at
  WHERE ROW(
    listing_public_feed_canonical.listing_id,
    listing_public_feed_canonical.canonical_created_at
  ) IS DISTINCT FROM ROW(
    EXCLUDED.listing_id,
    EXCLUDED.canonical_created_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION sync_listing_public_feed_canonical()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_listing_public_feed_canonical(OLD.dedupe_key);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.dedupe_key IS DISTINCT FROM NEW.dedupe_key THEN
    -- Always lock two changed groups in the same order to avoid A->B / B->A
    -- deadlocks when concurrent updates move listings between dedupe groups.
    IF OLD.dedupe_key < NEW.dedupe_key THEN
      PERFORM refresh_listing_public_feed_canonical(OLD.dedupe_key);
      PERFORM refresh_listing_public_feed_canonical(NEW.dedupe_key);
    ELSE
      PERFORM refresh_listing_public_feed_canonical(NEW.dedupe_key);
      PERFORM refresh_listing_public_feed_canonical(OLD.dedupe_key);
    END IF;
    RETURN NEW;
  END IF;

  PERFORM refresh_listing_public_feed_canonical(NEW.dedupe_key);
  RETURN NEW;
END;
$$;

-- Seed one winner per existing group before enabling incremental maintenance.
INSERT INTO listing_public_feed_canonical (
  dedupe_key,
  listing_id,
  canonical_created_at
)
SELECT winner.dedupe_key, winner.listing_id, winner.created_at
FROM (
  SELECT DISTINCT ON (m.dedupe_key)
    m.dedupe_key,
    m.listing_id,
    m.created_at
  FROM listing_public_feed_members AS m
  ORDER BY m.dedupe_key, m.created_at DESC NULLS LAST, m.listing_id DESC
) AS winner
ON CONFLICT (dedupe_key) DO UPDATE SET
  listing_id = EXCLUDED.listing_id,
  canonical_created_at = EXCLUDED.canonical_created_at;

DROP TRIGGER IF EXISTS listing_public_feed_members_sync_canonical
  ON listing_public_feed_members;
CREATE TRIGGER listing_public_feed_members_sync_canonical
AFTER INSERT OR DELETE OR UPDATE OF dedupe_key, created_at
ON listing_public_feed_members
FOR EACH ROW
EXECUTE FUNCTION sync_listing_public_feed_canonical();

ANALYZE listing_public_feed_canonical;
