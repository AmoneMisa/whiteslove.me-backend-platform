-- Materialize scalar values that are repeatedly cast out of the wide JSONB
-- payload during public search. STORED generated columns preserve the current
-- semantics: only JSON numbers participate; strings/unknown values remain NULL.
-- Keep all generated scalar additions in one ALTER TABLE so a fresh deployment
-- rewrites the listings heap once rather than repeating that work for spatial
-- coordinates in a later migration.
--
-- Do not build indexes in this migration. ALTER TABLE retains ACCESS EXCLUSIVE
-- until the migration transaction commits; moving index creation to 026 releases
-- that strongest lock before the longer index-build phase begins.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS bedrooms DOUBLE PRECISION
    GENERATED ALWAYS AS (
      CASE WHEN jsonb_typeof(data->'bedrooms') = 'number'
        THEN (data->>'bedrooms')::double precision
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS floor_number DOUBLE PRECISION
    GENERATED ALWAYS AS (
      CASE WHEN jsonb_typeof(data->'floor') = 'number'
        THEN (data->>'floor')::double precision
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS total_floors DOUBLE PRECISION
    GENERATED ALWAYS AS (
      CASE WHEN jsonb_typeof(data->'totalFloors') = 'number'
        THEN (data->>'totalFloors')::double precision
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS building_year DOUBLE PRECISION
    GENERATED ALWAYS AS (
      CASE WHEN jsonb_typeof(data->'buildingYear') = 'number'
        THEN (data->>'buildingYear')::double precision
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS commission_percent DOUBLE PRECISION
    GENERATED ALWAYS AS (
      CASE WHEN jsonb_typeof(data->'commissionPercent') = 'number'
        THEN (data->>'commissionPercent')::double precision
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS metro_distance_m DOUBLE PRECISION
    GENERATED ALWAYS AS (
      COALESCE(
        CASE WHEN jsonb_typeof(data->'metroDistanceM') = 'number'
          THEN (data->>'metroDistanceM')::double precision
          ELSE NULL
        END,
        CASE WHEN jsonb_typeof(data->'metroNearby'->0->'distanceM') = 'number'
          THEN (data->'metroNearby'->0->>'distanceM')::double precision
          ELSE NULL
        END
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION
    GENERATED ALWAYS AS (
      CASE WHEN jsonb_typeof(data->'lat') = 'number'
        THEN (data->>'lat')::double precision
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION
    GENERATED ALWAYS AS (
      CASE WHEN jsonb_typeof(data->'lng') = 'number'
        THEN (data->>'lng')::double precision
        ELSE NULL
      END
    ) STORED;
