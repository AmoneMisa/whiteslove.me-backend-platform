-- Keep the hot public-feed path on a compact index that already excludes rows
-- the API can never return. This complements the generic active dedupe indexes
-- from migration 010 and lets DISTINCT ON / COUNT(DISTINCT dedupe_key) avoid
-- scanning inactive, commercial, wanted, closed, and custom-source rows.
CREATE INDEX IF NOT EXISTS listings_public_feed_dedupe_created_idx
  ON listings(dedupe_key, created_at DESC, id DESC)
  WHERE active = TRUE
    AND source <> 'custom'
    AND NOT (data @> '{"commercial":true}'::jsonb)
    AND COALESCE(data->>'listingKind', 'propertyOffer') <> 'propertyWanted'
    AND COALESCE(data->>'listingStatus', 'active') NOT IN ('sold', 'rented', 'closed', 'outdated');

CREATE INDEX IF NOT EXISTS listings_public_feed_country_dedupe_created_idx
  ON listings(country, dedupe_key, created_at DESC, id DESC)
  WHERE active = TRUE
    AND source <> 'custom'
    AND NOT (data @> '{"commercial":true}'::jsonb)
    AND COALESCE(data->>'listingKind', 'propertyOffer') <> 'propertyWanted'
    AND COALESCE(data->>'listingStatus', 'active') NOT IN ('sold', 'rented', 'closed', 'outdated');
