-- Tune the compact public-feed read model for the filter combinations used most
-- often by the web/mobile UI. Keep the main listings heap out of the filtering
-- phase and make price-sorted pages cheap after dedupe.

-- Price sorting still converts currencies at request time, so keep price and
-- currency in the dedupe indexes themselves. PostgreSQL can build the newest
-- representative for each dedupe key without visiting the feed-members heap,
-- then sort that much smaller set by the converted price.
DROP INDEX IF EXISTS listing_public_feed_members_country_deal_dedupe_idx;
CREATE INDEX listing_public_feed_members_country_deal_dedupe_idx
  ON listing_public_feed_members (
    country,
    deal_type,
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency);

DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_dedupe_idx;
CREATE INDEX listing_public_feed_members_country_city_deal_dedupe_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency);

DROP INDEX IF EXISTS listing_public_feed_members_country_city_deal_owner_dedupe_idx;
CREATE INDEX listing_public_feed_members_country_city_deal_owner_dedupe_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    by_agency,
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency);

-- Rooms and area are the next most common range filters after price. They are
-- deliberately separate indexes: combining several range columns in one btree
-- makes the trailing keys ineffective.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_deal_rooms_dedupe_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    rooms,
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE rooms IS NOT NULL;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_deal_area_dedupe_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    area_sqm,
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE area_sqm IS NOT NULL;

-- The request predicates currently use LOWER(district/metro). Expression
-- indexes materialize that normalization at write/index-build time, so those
-- filters no longer require a row-by-row lowercase scan at request time.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_deal_district_key_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    (LOWER(district)),
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE district IS NOT NULL;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_deal_metro_key_idx
  ON listing_public_feed_members (
    country,
    city,
    deal_type,
    (LOWER(metro)),
    dedupe_key,
    created_at DESC NULLS LAST,
    listing_id DESC
  )
  INCLUDE (freshness_at, price, currency)
  WHERE metro IS NOT NULL;

-- Radius filters already use a bounding box before Haversine. Most radius
-- searches also have a selected city, so let that scope participate before the
-- latitude range rather than filtering city after a country-wide geo scan.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_lat_lng_idx
  ON listing_public_feed_members (country, city, lat, lng, listing_id)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;

ANALYZE listing_public_feed_members;
