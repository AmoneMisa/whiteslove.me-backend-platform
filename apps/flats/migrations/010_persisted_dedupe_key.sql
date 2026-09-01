-- Persist the exact public-feed deduplication fingerprint so reads do not
-- repeatedly normalize photos/title/description and calculate MD5 for every
-- matching row. The generated column keeps ingestion/update semantics atomic:
-- whenever a fingerprint input changes PostgreSQL recomputes the stored key.
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
    WHEN source = 'olx'
      AND LENGTH(photo0) >= 24
      AND LENGTH(photo1) >= 24
      AND photo0 <> photo1
      THEN 'olx:photos:' || MD5(CONCAT_WS('|', country, photo0, photo1))
    WHEN source = 'olx'
      AND LENGTH(description) >= 120
      THEN 'olx:content:' || MD5(CONCAT_WS('|',
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

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT
  GENERATED ALWAYS AS (
    compute_listing_dedupe_key(
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
      data
    )
  ) STORED;

ALTER TABLE listings
  ALTER COLUMN dedupe_key SET NOT NULL;

-- Supports the ROW_NUMBER/PARTITION BY dedupe_key visibility contract used by
-- both ordinary feed counts and exact stats. Country-specific recency indexes
-- remain useful for the initial filter/order path.
CREATE INDEX IF NOT EXISTS listings_active_dedupe_created_idx
  ON listings(dedupe_key, created_at DESC, id DESC)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS listings_active_country_dedupe_created_idx
  ON listings(country, dedupe_key, created_at DESC, id DESC)
  WHERE active = TRUE;
