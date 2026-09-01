-- Support the default newest/oldest feed by scanning visible rows in display
-- order and checking duplicate winners through the dedupe index. Keeping data
-- out of the index lets the feed fetch JSONB only for the final page rows.
CREATE INDEX IF NOT EXISTS listings_public_feed_created_dedupe_idx
  ON listings(created_at DESC, id DESC, dedupe_key)
  WHERE active = TRUE
    AND source <> 'custom'
    AND NOT (data @> '{"commercial":true}'::jsonb)
    AND COALESCE(data->>'listingKind', 'propertyOffer') <> 'propertyWanted'
    AND COALESCE(data->>'listingStatus', 'active') NOT IN ('sold', 'rented', 'closed', 'outdated');

CREATE INDEX IF NOT EXISTS listings_public_feed_country_created_dedupe_idx
  ON listings(country, created_at DESC, id DESC, dedupe_key)
  WHERE active = TRUE
    AND source <> 'custom'
    AND NOT (data @> '{"commercial":true}'::jsonb)
    AND COALESCE(data->>'listingKind', 'propertyOffer') <> 'propertyWanted'
    AND COALESCE(data->>'listingStatus', 'active') NOT IN ('sold', 'rented', 'closed', 'outdated');
