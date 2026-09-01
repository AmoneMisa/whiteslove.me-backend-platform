-- Extend the persisted public-feed fingerprint across sources without changing
-- the listings identity contract. (source, country, source_id) remains the
-- authoritative row identity; dedupe_key only controls which publication is
-- shown as the representative of the same property in public search results.
--
-- Cross-source matching is deliberately conservative. A shared key is emitted
-- only for strong evidence; otherwise the previous source-specific behaviour is
-- retained so two similar flats from the same agency are never merged merely
-- because their price/room count looks alike.
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
      LOWER(COALESCE(p_data->'photoFingerprints'->>0, '')) AS fingerprint0,
      LOWER(COALESCE(p_data->'photoFingerprints'->>1, '')) AS fingerprint1,
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
  ), strong AS (
    SELECT
      *,
      LEAST(fingerprint0, fingerprint1) AS fingerprint_lo,
      GREATEST(fingerprint0, fingerprint1) AS fingerprint_hi
    FROM normalized
  )
  SELECT CASE
    -- Two byte-level image fingerprints are strong enough to identify the same
    -- property even when title, source id or asking price changed. Include the
    -- deal/property type so a simultaneous sale and rental remain distinct.
    WHEN fingerprint0 ~ '^[a-f0-9]{64}$'
      AND fingerprint1 ~ '^[a-f0-9]{64}$'
      AND fingerprint0 <> fingerprint1
      THEN 'cross:photos:' || MD5(CONCAT_WS('|',
        country,
        deal_type,
        property_type,
        fingerprint_lo,
        fingerprint_hi
      ))

    -- A phone by itself is NOT unique (agencies reuse numbers). Require an
    -- exact normalized address plus core property facts. Price is intentionally
    -- omitted because reposts commonly change price without changing property.
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

    -- Exact normalized long-form copy across platforms. This is intentionally
    -- strict: both title and description participate, so generic realtor copy
    -- cannot merge unrelated flats merely because characteristics are similar.
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

    -- Preserve the historical in-source fallbacks for rows that do not have
    -- enough evidence for a cross-source identity.
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
  FROM strong;
$$;

-- STORED generated values are recalculated on row writes. Re-touch active rows
-- once so the new fingerprint applies immediately; the existing public-feed
-- trigger receives the new dedupe_key in the same transaction and refreshes its
-- narrow read model. Inactive history is recomputed naturally if reactivated.
UPDATE listings
SET data = data
WHERE active = TRUE;

ANALYZE listings;
ANALYZE listing_public_feed_members;
