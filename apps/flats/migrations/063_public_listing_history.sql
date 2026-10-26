-- Record actual changes, never one event per crawl. Existing first_seen_at is
-- kept as observation provenance; historic prices/publication cycles are not invented.
ALTER TABLE platform.listing_snapshots ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ;
-- A -> B -> A and repeated reappearances are distinct events. The old global
-- hash uniqueness erased them. The trigger gates on OLD/NEW instead.
DROP INDEX IF EXISTS platform.listing_snapshots_dedupe_idx;
CREATE INDEX IF NOT EXISTS listings_history_dedupe_key_idx ON listings(dedupe_key, id);

CREATE OR REPLACE FUNCTION platform.capture_public_listing_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changes TEXT[] := ARRAY[]::TEXT[]; state TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    changes := ARRAY['published'];
  ELSE
    IF OLD.created_at IS DISTINCT FROM NEW.created_at AND NEW.created_at IS NOT NULL THEN changes := array_append(changes, 'publication'); END IF;
    IF OLD.price IS DISTINCT FROM NEW.price OR OLD.currency IS DISTINCT FROM NEW.currency THEN changes := array_append(changes, 'price'); END IF;
    IF OLD.active IS DISTINCT FROM NEW.active THEN changes := array_append(changes, 'lifecycle'); END IF;
    IF OLD.data->>'contact' IS DISTINCT FROM NEW.data->>'contact' THEN changes := array_append(changes, 'contact'); END IF;
    IF OLD.title IS DISTINCT FROM NEW.title OR OLD.description IS DISTINCT FROM NEW.description THEN changes := array_append(changes, 'content'); END IF;
  END IF;
  IF cardinality(changes) = 0 THEN RETURN NEW; END IF;
  state := CASE WHEN NOT NEW.active THEN 'removed'
                WHEN TG_OP = 'INSERT' THEN 'published'
                WHEN NOT OLD.active THEN 'reappeared' ELSE 'active' END;
  INSERT INTO platform.listing_snapshots
    (listing_id, source, country, source_id, lifecycle_state, price, currency,
     source_published_at, changed, snapshot_hash)
  VALUES (NEW.id, NEW.source, NEW.country, NEW.source_id, state, NEW.price,
    NEW.currency, NEW.created_at, changes,
    encode(sha256(convert_to(jsonb_build_array(state, NEW.price, NEW.currency,
      NEW.created_at, NEW.title, NEW.description, NEW.data->>'contact')::text, 'UTF8')), 'hex'));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listings_capture_public_history ON listings;
CREATE TRIGGER listings_capture_public_history AFTER INSERT OR UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION platform.capture_public_listing_snapshot();
