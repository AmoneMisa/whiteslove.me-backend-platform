-- Realign the public-feed read model with the way it is actually queried.
--
-- 037 moved dedupe from request time to write time: listing_public_feed_canonical
-- holds one winner per dedupe group, and src/support/postgres-canonical-feed.js
-- is now the primary listing path. The member indexes from 035/036 were built
-- for the older DISTINCT ON (dedupe_key) feed, so every one of them places
-- dedupe_key between the equality keys and the sort keys:
--
--   (country, city, deal_type, dedupe_key, created_at DESC, listing_id DESC)
--
-- With dedupe already resolved, the canonical feed filters on the equality keys
-- and orders by created_at directly. A dedupe_key column in the middle breaks
-- that ordering, so every page had to sort the whole filtered set instead of
-- reading LIMIT rows off an ordered index.
--
-- Mark canonical membership on the member row so the winner set can carry
-- partial indexes, then rebuild the hot-path indexes in the shape the feed
-- actually asks for: equality keys, then created_at DESC, listing_id DESC.
--
-- Like 026 and 039 this runs as one ordinary transaction: the seed UPDATE
-- touches roughly one row per dedupe group and the index builds take a write
-- lock on listing_public_feed_members for their duration. That is acceptable
-- at the current table size; if it stops being so, split the CREATE INDEX
-- statements into a no-transaction migration using CONCURRENTLY.

ALTER TABLE listing_public_feed_members
  ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN NOT NULL DEFAULT FALSE;

-- listing_public_feed_canonical stays the authority for which row wins a group.
-- is_canonical is a denormalized copy maintained inside the same advisory-locked
-- section that writes it, so a committed reader can never observe the two out
-- of step.
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

  -- is_canonical is not in the AFTER UPDATE OF column list of
  -- listing_public_feed_members_sync_canonical, so this write does not
  -- re-enter the trigger.
  UPDATE listing_public_feed_members AS m
  SET is_canonical = (m.listing_id = v_listing_id)
  WHERE m.dedupe_key = p_dedupe_key
    AND m.is_canonical IS DISTINCT FROM (m.listing_id = v_listing_id);

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

-- Seed the flag from the already-maintained winner table.
UPDATE listing_public_feed_members AS m
SET is_canonical = TRUE
FROM listing_public_feed_canonical AS c
WHERE c.listing_id = m.listing_id
  AND NOT m.is_canonical;

UPDATE listing_public_feed_members AS m
SET is_canonical = FALSE
WHERE m.is_canonical
  AND NOT EXISTS (
    SELECT 1 FROM listing_public_feed_canonical AS c
    WHERE c.listing_id = m.listing_id
  );

-- The dedupe-shaped hot-path indexes from 035/036 have no remaining reader.
DROP INDEX IF EXISTS listing_public_feed_members_country_deal_dedupe_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_dedupe_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_owner_dedupe_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_rooms_dedupe_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_area_dedupe_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_district_key_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_metro_key_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_lat_lng_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_currency_price_idx;

-- Same for the pre-034 freshness/dedupe shapes: the age predicate rides along
-- as an INCLUDE payload below instead of leading its own index, and per-country
-- dedupe ordering is exactly what 037 replaced.
DROP INDEX IF EXISTS listing_public_feed_members_freshness_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_freshness_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_dedupe_created_idx;

-- listing_public_feed_members_dedupe_created_idx (014) is deliberately kept:
-- refresh_listing_public_feed_canonical() above looks a group up by dedupe_key.

-- Country-level browsing: the default feed with no city selected. This shape
-- had no usable index at all before, because the old path always went through
-- dedupe_key first.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_country_created_idx
  ON listing_public_feed_members (
    country,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE is_canonical;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_country_deal_created_idx
  ON listing_public_feed_members (
    country,
    deal_type,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE is_canonical;

-- Primary feed path.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_deal_created_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE is_canonical;

-- Second most common path: the same feed narrowed to owner/agency.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_deal_owner_created_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    by_agency,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE is_canonical;

-- Rooms and area are the next most common range filters after price. They stay
-- separate indexes: combining several range columns in one btree makes the
-- trailing keys ineffective.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_deal_rooms_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    rooms,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE is_canonical AND rooms IS NOT NULL;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_deal_area_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    area_sqm,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE is_canonical AND area_sqm IS NOT NULL;

-- The request predicates use LOWER(district/metro); match that expression so
-- those filters do not need a row-by-row lowercase pass.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_district_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    (LOWER(district)),
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE is_canonical AND district IS NOT NULL;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_metro_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    (LOWER(metro)),
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE is_canonical AND metro IS NOT NULL;

-- Price filtering is per-currency (FX conversion is folded into per-currency
-- bounds at request time), so currency leads price here. Price *sorting* stays
-- a sort: the converted expression depends on request-time rates.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_currency_price_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    (UPPER(currency)),
    price,
    listing_id
  )
  WHERE is_canonical AND price IS NOT NULL AND currency IS NOT NULL;

-- Radius filters bound latitude/longitude before the Haversine predicate.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_lat_lng_idx
  ON listing_public_feed_members (country, city, lat, lng, listing_id)
  WHERE is_canonical AND lat IS NOT NULL AND lng IS NOT NULL;

ANALYZE listing_public_feed_members;
