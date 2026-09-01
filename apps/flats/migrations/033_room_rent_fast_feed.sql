-- Make room rental a first-class deal type and teach the public-feed read
-- model enough about deal type to keep the normal UI feed on the fast path.
--
-- Historical rows represented room rental as deal_type = 'longRent' plus
-- data.roomOnly = true. Keep roomOnly as useful occupancy metadata, but make
-- deal_type = 'roomRent' the canonical persisted classification.

CREATE OR REPLACE FUNCTION canonicalize_listing_room_rent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.deal_type = 'longRent'
    AND NEW.data @> '{"roomOnly":true}'::jsonb
  THEN
    NEW.deal_type := 'roomRent';
    NEW.data := jsonb_set(NEW.data, '{dealType}', '"roomRent"'::jsonb, true);
  ELSIF NEW.deal_type = 'roomRent' THEN
    NEW.data := jsonb_set(NEW.data, '{dealType}', '"roomRent"'::jsonb, true);
    NEW.data := jsonb_set(NEW.data, '{roomOnly}', 'true'::jsonb, true);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_canonicalize_room_rent ON listings;
CREATE TRIGGER listings_canonicalize_room_rent
BEFORE INSERT OR UPDATE OF deal_type, data ON listings
FOR EACH ROW
EXECUTE FUNCTION canonicalize_listing_room_rent();

UPDATE listings
SET
  deal_type = 'roomRent',
  data = jsonb_set(data, '{dealType}', '"roomRent"'::jsonb, true)
WHERE deal_type = 'longRent'
  AND data @> '{"roomOnly":true}'::jsonb;

ALTER TABLE listing_public_feed_members
  ADD COLUMN IF NOT EXISTS deal_type VARCHAR(32);

UPDATE listing_public_feed_members AS member
SET deal_type = listing.deal_type
FROM listings AS listing
WHERE listing.id = member.listing_id
  AND member.deal_type IS DISTINCT FROM listing.deal_type;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_deal_freshness_idx
  ON listing_public_feed_members (
    country,
    deal_type,
    freshness_at DESC,
    dedupe_key,
    listing_id DESC
  );

CREATE OR REPLACE FUNCTION sync_listing_public_feed_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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
      deal_type,
      created_at,
      first_seen_at,
      freshness_at
    ) VALUES (
      NEW.id,
      NEW.dedupe_key,
      NEW.country,
      NEW.deal_type,
      NEW.created_at,
      NEW.first_seen_at,
      COALESCE(NEW.created_at, NEW.first_seen_at)
    )
    ON CONFLICT (listing_id) DO UPDATE SET
      dedupe_key = EXCLUDED.dedupe_key,
      country = EXCLUDED.country,
      deal_type = EXCLUDED.deal_type,
      created_at = EXCLUDED.created_at,
      first_seen_at = EXCLUDED.first_seen_at,
      freshness_at = EXCLUDED.freshness_at
    WHERE listing_public_feed_members.dedupe_key IS DISTINCT FROM EXCLUDED.dedupe_key
       OR listing_public_feed_members.country IS DISTINCT FROM EXCLUDED.country
       OR listing_public_feed_members.deal_type IS DISTINCT FROM EXCLUDED.deal_type
       OR listing_public_feed_members.created_at IS DISTINCT FROM EXCLUDED.created_at
       OR listing_public_feed_members.first_seen_at IS DISTINCT FROM EXCLUDED.first_seen_at
       OR listing_public_feed_members.freshness_at IS DISTINCT FROM EXCLUDED.freshness_at;
  ELSE
    DELETE FROM listing_public_feed_members
    WHERE listing_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

ANALYZE listings;
ANALYZE listing_public_feed_members;
