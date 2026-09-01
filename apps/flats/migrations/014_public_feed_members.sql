-- Maintain a narrow exact read-model for the public listing feed.
-- The main listings table contains large JSONB payloads; exact feed counts and
-- dedupe pagination only need identity, country and time columns. Keeping those
-- columns in a compact table avoids repeatedly reading the wide heap while
-- preserving exact semantics.
CREATE TABLE IF NOT EXISTS listing_public_feed_members (
  listing_id BIGINT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  country TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL,
  freshness_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION sync_listing_public_feed_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM listing_public_feed_members WHERE listing_id = NEW.id;

  IF NEW.active = TRUE
    AND NEW.source <> 'custom'
    AND NOT (NEW.data @> '{"commercial":true}'::jsonb)
    AND COALESCE(NEW.data->>'listingKind', 'propertyOffer') <> 'propertyWanted'
    AND COALESCE(NEW.data->>'listingStatus', 'active') NOT IN ('sold', 'rented', 'closed', 'outdated')
  THEN
    INSERT INTO listing_public_feed_members (
      listing_id,
      dedupe_key,
      country,
      created_at,
      first_seen_at,
      freshness_at
    ) VALUES (
      NEW.id,
      NEW.dedupe_key,
      NEW.country,
      NEW.created_at,
      NEW.first_seen_at,
      COALESCE(NEW.created_at, NEW.first_seen_at)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_sync_public_feed_member ON listings;
CREATE TRIGGER listings_sync_public_feed_member
AFTER INSERT OR UPDATE OF
  source,
  country,
  source_id,
  title,
  description,
  property_type,
  deal_type,
  city,
  price,
  currency,
  rooms,
  area_sqm,
  data,
  active,
  created_at,
  first_seen_at
ON listings
FOR EACH ROW
EXECUTE FUNCTION sync_listing_public_feed_member();

-- Seed the read-model from the current authoritative rows after the 14-day
-- lifecycle migration has already deactivated historical listings.
TRUNCATE listing_public_feed_members;
INSERT INTO listing_public_feed_members (
  listing_id,
  dedupe_key,
  country,
  created_at,
  first_seen_at,
  freshness_at
)
SELECT
  id,
  dedupe_key,
  country,
  created_at,
  first_seen_at,
  COALESCE(created_at, first_seen_at)
FROM listings
WHERE active = TRUE
  AND source <> 'custom'
  AND NOT (data @> '{"commercial":true}'::jsonb)
  AND COALESCE(data->>'listingKind', 'propertyOffer') <> 'propertyWanted'
  AND COALESCE(data->>'listingStatus', 'active') NOT IN ('sold', 'rented', 'closed', 'outdated');

CREATE INDEX IF NOT EXISTS listing_public_feed_members_dedupe_created_idx
  ON listing_public_feed_members(dedupe_key, created_at DESC, listing_id DESC);

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_dedupe_created_idx
  ON listing_public_feed_members(country, dedupe_key, created_at DESC, listing_id DESC);

CREATE INDEX IF NOT EXISTS listing_public_feed_members_freshness_idx
  ON listing_public_feed_members(freshness_at DESC, dedupe_key, listing_id DESC);

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_freshness_idx
  ON listing_public_feed_members(country, freshness_at DESC, dedupe_key, listing_id DESC);

-- Makes the background 14-day deactivation sweep cheap as rows age out.
CREATE INDEX IF NOT EXISTS listings_active_freshness_idx
  ON listings((COALESCE(created_at, first_seen_at)), id)
  WHERE active = TRUE;

ANALYZE listing_public_feed_members;
