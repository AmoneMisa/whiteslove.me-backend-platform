-- Expose the existing listings BIGSERIAL id as a stable short public id.
-- source_id remains the source-specific identity (OLX offer id, Telegram message id, etc.).

CREATE OR REPLACE FUNCTION listings_sync_public_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.data = jsonb_set(
    COALESCE(NEW.data, '{}'::jsonb),
    '{publicId}',
    to_jsonb(NEW.id),
    true
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_sync_public_id_trigger ON listings;

CREATE TRIGGER listings_sync_public_id_trigger
BEFORE INSERT OR UPDATE OF data ON listings
FOR EACH ROW
EXECUTE FUNCTION listings_sync_public_id();

-- Backfill all existing rows so the public id is available immediately after migration.
UPDATE listings
SET data = jsonb_set(
  COALESCE(data, '{}'::jsonb),
  '{publicId}',
  to_jsonb(id),
  true
)
WHERE data->>'publicId' IS DISTINCT FROM id::text;
