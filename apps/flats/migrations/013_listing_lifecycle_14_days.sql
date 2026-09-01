-- Apartments are considered fresh for 14 days, matching the parser lifecycle.
-- Keep stale rows for history/deduplication, but never let them participate in
-- active-feed indexes or become active again through a later upsert.
CREATE OR REPLACE FUNCTION enforce_listing_lifecycle_14_days()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_at timestamptz;
BEGIN
  lifecycle_at := COALESCE(NEW.created_at, NEW.first_seen_at, NOW());

  IF lifecycle_at < NOW() - INTERVAL '14 days' THEN
    NEW.active := FALSE;
    NEW.inactive_at := COALESCE(NEW.inactive_at, NOW());
  ELSIF NEW.active = TRUE THEN
    NEW.inactive_at := NULL;
  ELSIF NEW.active = FALSE THEN
    IF TG_OP = 'INSERT' THEN
      NEW.inactive_at := COALESCE(NEW.inactive_at, NOW());
    ELSIF OLD.active IS DISTINCT FROM FALSE THEN
      NEW.inactive_at := COALESCE(NEW.inactive_at, NOW());
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Apply the lifecycle immediately to data accumulated before this rule existed.
UPDATE listings
SET
  active = FALSE,
  inactive_at = COALESCE(inactive_at, NOW()),
  updated_at = NOW()
WHERE active = TRUE
  AND COALESCE(created_at, first_seen_at) < NOW() - INTERVAL '14 days';

DROP TRIGGER IF EXISTS listings_enforce_lifecycle_14_days ON listings;
CREATE TRIGGER listings_enforce_lifecycle_14_days
BEFORE INSERT OR UPDATE OF created_at, first_seen_at, active
ON listings
FOR EACH ROW
EXECUTE FUNCTION enforce_listing_lifecycle_14_days();
