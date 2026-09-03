-- Title ordering has been retired from the product.
--
-- It was the one sort the public-feed read model could not serve: ORDER BY
-- LOWER(title) forced the request off listing_public_feed_members onto the
-- general search path, where it ranked and sorted the whole matching set. The
-- Flutter client no longer offers it and the API no longer accepts it
-- (VALID_SORTS in src/routes/listing-routes.js), so listings_feed_title_idx
-- from 003_search_indexes.sql has no reader left.
--
-- Its (country, city, deal_type) prefix is already covered by
-- listings_feed_newest_idx, which additionally carries the created_at ordering
-- the remaining sorts actually use. Dropping it removes per-row index
-- maintenance on every listing write.

DROP INDEX IF EXISTS listings_feed_title_idx;

ANALYZE listings;
