-- Make property identity a single persisted concept.
--
-- Photo/perceptual matching owns confident property clusters. Public-feed
-- dedupe consumes that cluster id first and falls back to deterministic
-- fingerprints only when a cluster is not known yet. Runtime modules no longer
-- own schema creation; all anti-fake tables and indexes are versioned here.

CREATE TABLE IF NOT EXISTS listing_photo_hashes (
  hash CHAR(64) NOT NULL,
  source VARCHAR(32) NOT NULL,
  country VARCHAR(8) NOT NULL,
  source_id TEXT NOT NULL,
  city TEXT,
  photo_url TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  perceptual_hash CHAR(16),
  title TEXT,
  price NUMERIC,
  currency VARCHAR(16),
  by_agency BOOLEAN,
  rooms NUMERIC,
  area_sqm NUMERIC,
  district TEXT,
  metro TEXT,
  residence_complex TEXT,
  created_at TIMESTAMPTZ,
  PRIMARY KEY (hash, source, country, source_id, photo_url)
);

-- Production instances may already have the historical runtime-created table.
-- Keep the migration idempotent for those installations.
ALTER TABLE listing_photo_hashes
  ADD COLUMN IF NOT EXISTS perceptual_hash CHAR(16),
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS price NUMERIC,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(16),
  ADD COLUMN IF NOT EXISTS by_agency BOOLEAN,
  ADD COLUMN IF NOT EXISTS rooms NUMERIC,
  ADD COLUMN IF NOT EXISTS area_sqm NUMERIC,
  ADD COLUMN IF NOT EXISTS district TEXT,
  ADD COLUMN IF NOT EXISTS metro TEXT,
  ADD COLUMN IF NOT EXISTS residence_complex TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS listing_photo_hashes_hash_idx
  ON listing_photo_hashes(hash);
CREATE INDEX IF NOT EXISTS listing_photo_hashes_listing_idx
  ON listing_photo_hashes(source, country, source_id);
CREATE INDEX IF NOT EXISTS listing_photo_hashes_perceptual_country_idx
  ON listing_photo_hashes(country, perceptual_hash)
  WHERE perceptual_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS listing_property_clusters (
  source VARCHAR(32) NOT NULL,
  country VARCHAR(8) NOT NULL,
  source_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  first_joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, country, source_id)
);

CREATE INDEX IF NOT EXISTS listing_property_clusters_cluster_idx
  ON listing_property_clusters(cluster_id);

-- If a cluster already exists when a listing is inserted/refreshed, inject its
-- id before the generated dedupe_key is calculated.
CREATE OR REPLACE FUNCTION listings_apply_property_cluster_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cluster_id TEXT;
BEGIN
  SELECT cluster_id
    INTO v_cluster_id
    FROM listing_property_clusters
   WHERE source = LOWER(NEW.source)
     AND country = UPPER(NEW.country)
     AND source_id = NEW.source_id
   LIMIT 1;

  IF v_cluster_id IS NOT NULL THEN
    NEW.data = jsonb_set(
      COALESCE(NEW.data, '{}'::jsonb),
      '{propertyClusterId}',
      to_jsonb(v_cluster_id),
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_apply_property_cluster_id_trigger ON listings;
CREATE TRIGGER listings_apply_property_cluster_id_trigger
BEFORE INSERT OR UPDATE OF source, country, source_id, data ON listings
FOR EACH ROW
EXECUTE FUNCTION listings_apply_property_cluster_id();

-- When photo matching creates or merges a cluster, propagate it back to the
-- canonical listings row. Updating data recomputes the STORED dedupe_key and
-- the existing public-feed trigger refreshes its narrow read model.
CREATE OR REPLACE FUNCTION sync_property_cluster_to_listing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE listings
       SET data = data - 'propertyClusterId'
     WHERE source = OLD.source
       AND country = OLD.country
       AND source_id = OLD.source_id
       AND data->>'propertyClusterId' = OLD.cluster_id;
    RETURN OLD;
  END IF;

  UPDATE listings
     SET data = jsonb_set(
       COALESCE(data, '{}'::jsonb),
       '{propertyClusterId}',
       to_jsonb(NEW.cluster_id),
       true
     )
   WHERE source = NEW.source
     AND country = NEW.country
     AND source_id = NEW.source_id
     AND data->>'propertyClusterId' IS DISTINCT FROM NEW.cluster_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listing_property_clusters_sync_listing ON listing_property_clusters;
CREATE TRIGGER listing_property_clusters_sync_listing
AFTER INSERT OR UPDATE OF cluster_id OR DELETE ON listing_property_clusters
FOR EACH ROW
EXECUTE FUNCTION sync_property_cluster_to_listing();

-- Backfill clusters created by the historical runtime schema.
UPDATE listings AS l
   SET data = jsonb_set(
     COALESCE(l.data, '{}'::jsonb),
     '{propertyClusterId}',
     to_jsonb(c.cluster_id),
     true
   )
  FROM listing_property_clusters AS c
 WHERE l.source = c.source
   AND l.country = c.country
   AND l.source_id = c.source_id
   AND l.data->>'propertyClusterId' IS DISTINCT FROM c.cluster_id;

-- The cluster id is authoritative for strong photo/perceptual matches.
-- Deterministic text/contact fingerprints remain cheap fallbacks for listings
-- that have not received a property cluster.
CREATE OR REPLACE FUNCTION compute_listing_dedupe_key(
  p_source TEXT,
  p_country TEXT,
  p_source_id TEXT,
  p_title TEXT,
  p_description TEXT,
  p_property_type TEXT,
  p_deal_type TEXT,
  p_city TEXT,
  p_price DOUBLE PRECISION,
  p_currency TEXT,
  p_rooms INTEGER,
  p_area_sqm DOUBLE PRECISION,
  p_data JSONB
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH normalized AS (
    SELECT
      LOWER(COALESCE(p_source, '')) AS source,
      UPPER(COALESCE(p_country, '')) AS country,
      COALESCE(p_source_id, '') AS source_id,
      LOWER(COALESCE(p_city, '')) AS city,
      COALESCE(p_deal_type, '') AS deal_type,
      COALESCE(p_property_type, '') AS property_type,
      COALESCE(p_price::text, '') AS price,
      UPPER(COALESCE(p_currency, '')) AS currency,
      COALESCE(p_rooms::text, '') AS rooms,
      COALESCE(ROUND(p_area_sqm::numeric, 1)::text, '') AS area_sqm,
      LOWER(REGEXP_REPLACE(BTRIM(COALESCE(p_title, '')), '\s+', ' ', 'g')) AS title,
      LOWER(REGEXP_REPLACE(BTRIM(COALESCE(p_description, '')), '\s+', ' ', 'g')) AS description,
      LOWER(REGEXP_REPLACE(BTRIM(COALESCE(p_data->>'address', '')), '[[:space:][:punct:]]+', ' ', 'g')) AS address,
      COALESCE(p_data->>'floor', '') AS floor,
      COALESCE(NULLIF(BTRIM(p_data->>'propertyClusterId'), ''), '') AS property_cluster_id,
      REGEXP_REPLACE(
        CASE
          WHEN jsonb_typeof(p_data->'contact') = 'string' THEN COALESCE(p_data->>'contact', '')
          WHEN jsonb_typeof(p_data->'contact') = 'object' THEN COALESCE(
            p_data->'contact'->>'phone',
            p_data->'contact'->>'number',
            p_data->'contact'->>'value',
            ''
          )
          ELSE COALESCE(p_data->>'phone', '')
        END,
        '[^0-9]+',
        '',
        'g'
      ) AS phone_digits,
      LOWER(REGEXP_REPLACE(SPLIT_PART(COALESCE(
        CASE
          WHEN jsonb_typeof(p_data->'photos'->0) = 'string' THEN p_data->'photos'->>0
          WHEN jsonb_typeof(p_data->'photos'->0) = 'object' THEN COALESCE(
            p_data->'photos'->0->>'link',
            p_data->'photos'->0->>'url',
            p_data->'photos'->0->>'src',
            ''
          )
          ELSE ''
        END,
        ''
      ), '?', 1), ';s=.*$', '')) AS photo0,
      LOWER(REGEXP_REPLACE(SPLIT_PART(COALESCE(
        CASE
          WHEN jsonb_typeof(p_data->'photos'->1) = 'string' THEN p_data->'photos'->>1
          WHEN jsonb_typeof(p_data->'photos'->1) = 'object' THEN COALESCE(
            p_data->'photos'->1->>'link',
            p_data->'photos'->1->>'url',
            p_data->'photos'->1->>'src',
            ''
          )
          ELSE ''
        END,
        ''
      ), '?', 1), ';s=.*$', '')) AS photo1,
      COALESCE(p_data->>'photoFingerprintKey', '') AS telegram_photo_key
  )
  SELECT CASE
    WHEN property_cluster_id <> ''
      THEN 'cluster:' || property_cluster_id

    -- Phone alone is never enough because agencies reuse numbers.
    WHEN LENGTH(phone_digits) >= 9
      AND LENGTH(address) >= 8
      AND rooms <> ''
      AND (area_sqm <> '' OR floor <> '')
      THEN 'cross:contact-address:' || MD5(CONCAT_WS('|',
        country,
        city,
        deal_type,
        property_type,
        phone_digits,
        address,
        rooms,
        area_sqm,
        floor
      ))

    WHEN LENGTH(title) >= 8
      AND LENGTH(description) >= 120
      THEN 'cross:content:' || MD5(CONCAT_WS('|',
        country,
        city,
        deal_type,
        property_type,
        price,
        currency,
        rooms,
        area_sqm,
        title,
        description
      ))

    -- Historical in-source fallbacks remain intentionally source-scoped.
    WHEN source = 'olx'
      AND LENGTH(photo0) >= 24
      AND LENGTH(photo1) >= 24
      AND photo0 <> photo1
      THEN 'olx:photos:' || MD5(CONCAT_WS('|', country, photo0, photo1))
    WHEN source = 'telegram'
      AND LENGTH(telegram_photo_key) >= 129
      THEN 'telegram:photos:' || MD5(CONCAT_WS('|', country, telegram_photo_key))
    WHEN source = 'telegram'
      AND LENGTH(description) >= 40
      THEN 'telegram:content:' || MD5(CONCAT_WS('|',
        country,
        city,
        deal_type,
        property_type,
        price,
        currency,
        rooms,
        area_sqm,
        title,
        description
      ))
    ELSE CONCAT_WS(':', source, country, source_id)
  END
  FROM normalized;
$$;

-- Recompute active generated keys after replacing the immutable function.
UPDATE listings
SET data = data
WHERE active = TRUE;

ANALYZE listings;
ANALYZE listing_property_clusters;
ANALYZE listing_photo_hashes;
ANALYZE listing_public_feed_members;
