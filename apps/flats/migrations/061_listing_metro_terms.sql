-- Every metro station a listing names, not just the primary one.
--
-- A flat "between Novza and Chilonzor" keeps `metro` = one station, and the
-- lexicon now also returns `metros` with all of them. The metro name filter
-- matched only listings.metro, so a search for the second station missed the
-- flat. Materialize each station as a 'listing_metro' term so the filter can
-- use the same indexed semi-join as microdistricts.
--
-- A separate trigger (not a rewrite of sync_listing_search_relations) keeps
-- migration 025's function untouched. PostgreSQL fires same-event triggers in
-- name order, so '..._metro' runs after the main rebuild, which deletes every
-- term for the listing; this trigger therefore also fires whenever that one
-- does, and restores the station rows.

CREATE OR REPLACE FUNCTION sync_listing_metro_terms()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM listing_location_terms
  WHERE listing_id = NEW.id AND term_type = 'listing_metro';

  INSERT INTO listing_location_terms(listing_id, term_type, normalized_name)
  SELECT DISTINCT NEW.id, 'listing_metro', normalized_name
  FROM (
    SELECT LEFT(LOWER(BTRIM(NEW.data->>'metro')), 512) AS normalized_name
    WHERE NULLIF(BTRIM(NEW.data->>'metro'), '') IS NOT NULL

    UNION ALL
    SELECT LEFT(LOWER(BTRIM(value)), 512)
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(NEW.data->'metros') = 'array'
        THEN NEW.data->'metros' ELSE '[]'::jsonb END
    ) AS value
    WHERE NULLIF(BTRIM(value), '') IS NOT NULL
  ) terms
  WHERE normalized_name IS NOT NULL AND normalized_name <> ''
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_insert_search_relations_metro ON listings;
DROP TRIGGER IF EXISTS listings_update_search_relations_metro ON listings;

CREATE TRIGGER listings_insert_search_relations_metro
AFTER INSERT ON listings
FOR EACH ROW
EXECUTE FUNCTION sync_listing_metro_terms();

CREATE TRIGGER listings_update_search_relations_metro
AFTER UPDATE OF data ON listings
FOR EACH ROW
WHEN (
  (OLD.data->'metro') IS DISTINCT FROM (NEW.data->'metro')
  OR (OLD.data->'metros') IS DISTINCT FROM (NEW.data->'metros')
  -- Same fields as listings_update_search_relations (migration 025): when it
  -- rebuilds the listing's terms it deletes these rows too.
  OR (OLD.data->'microdistrict') IS DISTINCT FROM (NEW.data->'microdistrict')
  OR (OLD.data->'kvartal') IS DISTINCT FROM (NEW.data->'kvartal')
  OR (OLD.data->'area') IS DISTINCT FROM (NEW.data->'area')
  OR (OLD.data->'localAreas') IS DISTINCT FROM (NEW.data->'localAreas')
  OR (OLD.data->'developmentAreas') IS DISTINCT FROM (NEW.data->'developmentAreas')
  OR (OLD.data->'informalAreas') IS DISTINCT FROM (NEW.data->'informalAreas')
  OR (OLD.data->'locationEntities') IS DISTINCT FROM (NEW.data->'locationEntities')
  OR (OLD.data->'nearbyPlaces') IS DISTINCT FROM (NEW.data->'nearbyPlaces')
)
EXECUTE FUNCTION sync_listing_metro_terms();

-- Backfill current rows from the same sources.
INSERT INTO listing_location_terms(listing_id, term_type, normalized_name)
SELECT DISTINCT listing_id, 'listing_metro', normalized_name
FROM (
  SELECT l.id AS listing_id, LEFT(LOWER(BTRIM(l.data->>'metro')), 512) AS normalized_name
  FROM listings l
  WHERE NULLIF(BTRIM(l.data->>'metro'), '') IS NOT NULL

  UNION ALL
  SELECT l.id, LEFT(LOWER(BTRIM(value)), 512)
  FROM listings l
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(l.data->'metros') = 'array'
      THEN l.data->'metros' ELSE '[]'::jsonb END
  ) AS value
  WHERE NULLIF(BTRIM(value), '') IS NOT NULL
) terms
WHERE normalized_name IS NOT NULL AND normalized_name <> ''
ON CONFLICT DO NOTHING;
