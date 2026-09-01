-- Tune public-feed read-model indexes for the actual hot paths and DISTINCT ON
-- access pattern.
--
-- The dominant UI shapes are:
--   country + city + deal
--   country + city + deal + owner/agency
--
-- After equality filtering, the feed chooses the newest row per dedupe_key using:
--   ORDER BY dedupe_key, created_at DESC NULLS LAST, listing_id DESC
--
-- Keep those equality prefixes first, then the exact dedupe ordering. freshness_at
-- stays included for the residual age predicate instead of breaking index order
-- with a range column before dedupe_key.

DROP INDEX IF EXISTS listing_public_feed_members_country_deal_freshness_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_fresh_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_deal_owner_fresh_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_source_fresh_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_deal_price_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_source_dedupe_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_deal_owner_dedupe_idx;
DROP INDEX IF EXISTS listing_public_feed_members_country_deal_currency_price_idx;

-- Fallback for country-level browsing when city is intentionally omitted.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_deal_dedupe_idx
  ON listing_public_feed_members (
    country,
    deal_type,
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at);

-- Primary feed path.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_deal_dedupe_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at);

-- Second most common path: the same feed narrowed to owner/agency.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_deal_owner_dedupe_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    by_agency,
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at);

-- FX-aware filtering deliberately uses UPPER(m.currency). Match that expression
-- and include city because price filters normally run inside the city feed.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_deal_currency_price_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    UPPER(currency),
    price,
    listing_id
  )
  WHERE price IS NOT NULL AND currency IS NOT NULL;

ANALYZE listing_public_feed_members;
