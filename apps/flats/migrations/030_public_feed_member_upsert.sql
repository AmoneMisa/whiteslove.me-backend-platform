-- The original read-model trigger deleted the membership row and inserted it
-- again for every relevant listing update, even when the listing remained
-- publicly visible. Preserve identical visibility semantics while using an
-- in-place upsert for visible rows and DELETE only when a row leaves the feed.

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
    )
    ON CONFLICT (listing_id) DO UPDATE SET
      dedupe_key = EXCLUDED.dedupe_key,
      country = EXCLUDED.country,
      created_at = EXCLUDED.created_at,
      first_seen_at = EXCLUDED.first_seen_at,
      freshness_at = EXCLUDED.freshness_at
    WHERE listing_public_feed_members.dedupe_key IS DISTINCT FROM EXCLUDED.dedupe_key
       OR listing_public_feed_members.country IS DISTINCT FROM EXCLUDED.country
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

ANALYZE listing_public_feed_members;
