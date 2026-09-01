-- Normalize repeated JSONB arrays used by location/nearby filters. Search can
-- now use indexed semi-joins instead of expanding JSON arrays for every
-- candidate listing on every request.

CREATE TABLE IF NOT EXISTS listing_location_terms (
  listing_id BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  term_type VARCHAR(64) NOT NULL,
  normalized_name VARCHAR(512) NOT NULL,
  PRIMARY KEY (listing_id, term_type, normalized_name)
);

CREATE INDEX IF NOT EXISTS listing_location_terms_lookup_idx
  ON listing_location_terms(term_type, normalized_name, listing_id);

CREATE TABLE IF NOT EXISTS listing_nearby_places (
  listing_id BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  place_index INTEGER NOT NULL,
  kind VARCHAR(64),
  distance_m DOUBLE PRECISION,
  PRIMARY KEY (listing_id, place_index)
);

CREATE INDEX IF NOT EXISTS listing_nearby_places_kind_distance_idx
  ON listing_nearby_places(kind, distance_m, listing_id)
  WHERE kind IS NOT NULL;

CREATE INDEX IF NOT EXISTS listing_nearby_places_distance_idx
  ON listing_nearby_places(distance_m, listing_id)
  WHERE distance_m IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_listing_search_relations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM listing_location_terms WHERE listing_id = NEW.id;
  DELETE FROM listing_nearby_places WHERE listing_id = NEW.id;

  -- These tables are derived acceleration structures. Bound upstream labels at
  -- materialization time so an unexpectedly verbose enrichment value cannot
  -- make the canonical listing INSERT/UPDATE fail merely because the helper
  -- index uses a narrower schema contract.
  INSERT INTO listing_location_terms(listing_id, term_type, normalized_name)
  SELECT DISTINCT NEW.id, term_type, normalized_name
  FROM (
    SELECT 'microdistrict'::text AS term_type, LEFT(LOWER(BTRIM(NEW.data->>'microdistrict')), 512) AS normalized_name
    WHERE NULLIF(BTRIM(NEW.data->>'microdistrict'), '') IS NOT NULL

    UNION ALL
    SELECT 'quartal', LEFT(LOWER(BTRIM(NEW.data->>'kvartal')), 512)
    WHERE NULLIF(BTRIM(NEW.data->>'kvartal'), '') IS NOT NULL

    UNION ALL
    SELECT 'area', LEFT(LOWER(BTRIM(NEW.data->>'area')), 512)
    WHERE NULLIF(BTRIM(NEW.data->>'area'), '') IS NOT NULL

    UNION ALL
    SELECT 'local_area', LEFT(LOWER(BTRIM(value)), 512)
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(NEW.data->'localAreas') = 'array'
        THEN NEW.data->'localAreas' ELSE '[]'::jsonb END
    ) AS value
    WHERE NULLIF(BTRIM(value), '') IS NOT NULL

    UNION ALL
    SELECT 'development_area', LEFT(LOWER(BTRIM(value)), 512)
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(NEW.data->'developmentAreas') = 'array'
        THEN NEW.data->'developmentAreas' ELSE '[]'::jsonb END
    ) AS value
    WHERE NULLIF(BTRIM(value), '') IS NOT NULL

    UNION ALL
    SELECT 'informal_area', LEFT(LOWER(BTRIM(value)), 512)
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(NEW.data->'informalAreas') = 'array'
        THEN NEW.data->'informalAreas' ELSE '[]'::jsonb END
    ) AS value
    WHERE NULLIF(BTRIM(value), '') IS NOT NULL

    UNION ALL
    SELECT
      LEFT(LOWER(BTRIM(entity->>'type')), 64),
      LEFT(LOWER(BTRIM(entity->>'name')), 512)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(NEW.data->'locationEntities') = 'array'
        THEN NEW.data->'locationEntities' ELSE '[]'::jsonb END
    ) AS entity
    WHERE NULLIF(BTRIM(entity->>'type'), '') IS NOT NULL
      AND NULLIF(BTRIM(entity->>'name'), '') IS NOT NULL
  ) terms
  WHERE normalized_name IS NOT NULL AND normalized_name <> '';

  INSERT INTO listing_nearby_places(listing_id, place_index, kind, distance_m)
  SELECT
    NEW.id,
    (ordinality - 1)::integer,
    NULLIF(LEFT(LOWER(BTRIM(place->>'kind')), 64), ''),
    CASE WHEN jsonb_typeof(place->'distanceM') = 'number'
      THEN (place->>'distanceM')::double precision
      ELSE NULL
    END
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(NEW.data->'nearbyPlaces') = 'array'
      THEN NEW.data->'nearbyPlaces' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS item(place, ordinality)
  WHERE NULLIF(BTRIM(place->>'kind'), '') IS NOT NULL
     OR jsonb_typeof(place->'distanceM') = 'number';

  RETURN NEW;
END;
$$;

-- Inserts always need relation materialization. Updates rebuild only when one
-- of the JSON fragments that owns these relations actually changed; routine
-- price/availability/anti-fake updates therefore do not churn relation rows.
DROP TRIGGER IF EXISTS listings_sync_search_relations ON listings;
DROP TRIGGER IF EXISTS listings_insert_search_relations ON listings;
DROP TRIGGER IF EXISTS listings_update_search_relations ON listings;

CREATE TRIGGER listings_insert_search_relations
AFTER INSERT ON listings
FOR EACH ROW
EXECUTE FUNCTION sync_listing_search_relations();

CREATE TRIGGER listings_update_search_relations
AFTER UPDATE OF data ON listings
FOR EACH ROW
WHEN (
  (OLD.data->'microdistrict') IS DISTINCT FROM (NEW.data->'microdistrict')
  OR (OLD.data->'kvartal') IS DISTINCT FROM (NEW.data->'kvartal')
  OR (OLD.data->'area') IS DISTINCT FROM (NEW.data->'area')
  OR (OLD.data->'localAreas') IS DISTINCT FROM (NEW.data->'localAreas')
  OR (OLD.data->'developmentAreas') IS DISTINCT FROM (NEW.data->'developmentAreas')
  OR (OLD.data->'informalAreas') IS DISTINCT FROM (NEW.data->'informalAreas')
  OR (OLD.data->'locationEntities') IS DISTINCT FROM (NEW.data->'locationEntities')
  OR (OLD.data->'nearbyPlaces') IS DISTINCT FROM (NEW.data->'nearbyPlaces')
)
EXECUTE FUNCTION sync_listing_search_relations();

-- Backfill current rows once. Use the same semantic sources and the same
-- materialization bounds as the trigger.
INSERT INTO listing_location_terms(listing_id, term_type, normalized_name)
SELECT DISTINCT listing_id, term_type, normalized_name
FROM (
  SELECT l.id AS listing_id, 'microdistrict'::text AS term_type, LEFT(LOWER(BTRIM(l.data->>'microdistrict')), 512) AS normalized_name
  FROM listings l
  WHERE NULLIF(BTRIM(l.data->>'microdistrict'), '') IS NOT NULL

  UNION ALL
  SELECT l.id, 'quartal', LEFT(LOWER(BTRIM(l.data->>'kvartal')), 512)
  FROM listings l
  WHERE NULLIF(BTRIM(l.data->>'kvartal'), '') IS NOT NULL

  UNION ALL
  SELECT l.id, 'area', LEFT(LOWER(BTRIM(l.data->>'area')), 512)
  FROM listings l
  WHERE NULLIF(BTRIM(l.data->>'area'), '') IS NOT NULL

  UNION ALL
  SELECT l.id, 'local_area', LEFT(LOWER(BTRIM(value)), 512)
  FROM listings l
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(l.data->'localAreas') = 'array'
      THEN l.data->'localAreas' ELSE '[]'::jsonb END
  ) AS value
  WHERE NULLIF(BTRIM(value), '') IS NOT NULL

  UNION ALL
  SELECT l.id, 'development_area', LEFT(LOWER(BTRIM(value)), 512)
  FROM listings l
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(l.data->'developmentAreas') = 'array'
      THEN l.data->'developmentAreas' ELSE '[]'::jsonb END
  ) AS value
  WHERE NULLIF(BTRIM(value), '') IS NOT NULL

  UNION ALL
  SELECT l.id, 'informal_area', LEFT(LOWER(BTRIM(value)), 512)
  FROM listings l
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(l.data->'informalAreas') = 'array'
      THEN l.data->'informalAreas' ELSE '[]'::jsonb END
  ) AS value
  WHERE NULLIF(BTRIM(value), '') IS NOT NULL

  UNION ALL
  SELECT l.id, LEFT(LOWER(BTRIM(entity->>'type')), 64), LEFT(LOWER(BTRIM(entity->>'name')), 512)
  FROM listings l
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.data->'locationEntities') = 'array'
      THEN l.data->'locationEntities' ELSE '[]'::jsonb END
  ) AS entity
  WHERE NULLIF(BTRIM(entity->>'type'), '') IS NOT NULL
    AND NULLIF(BTRIM(entity->>'name'), '') IS NOT NULL
) terms
WHERE normalized_name IS NOT NULL AND normalized_name <> ''
ON CONFLICT DO NOTHING;

INSERT INTO listing_nearby_places(listing_id, place_index, kind, distance_m)
SELECT
  l.id,
  (ordinality - 1)::integer,
  NULLIF(LEFT(LOWER(BTRIM(place->>'kind')), 64), ''),
  CASE WHEN jsonb_typeof(place->'distanceM') = 'number'
    THEN (place->>'distanceM')::double precision
    ELSE NULL
  END
FROM listings l
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(l.data->'nearbyPlaces') = 'array'
    THEN l.data->'nearbyPlaces' ELSE '[]'::jsonb END
) WITH ORDINALITY AS item(place, ordinality)
WHERE NULLIF(BTRIM(place->>'kind'), '') IS NOT NULL
   OR jsonb_typeof(place->'distanceM') = 'number'
ON CONFLICT (listing_id, place_index) DO UPDATE SET
  kind = EXCLUDED.kind,
  distance_m = EXCLUDED.distance_m;

ANALYZE listing_location_terms;
ANALYZE listing_nearby_places;
