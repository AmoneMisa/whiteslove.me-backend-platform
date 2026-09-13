-- Lets the snapshot builder skip a city/locale's expensive zone/option
-- computation when nothing that could change its output has changed since the
-- last build. Nullable: existing rows have no input hash yet and are treated
-- as unknown, forcing exactly one more full rebuild after this migration.
ALTER TABLE geo_city_snapshots ADD COLUMN IF NOT EXISTS input_hash VARCHAR(64);
ALTER TABLE geo_city_options ADD COLUMN IF NOT EXISTS input_hash VARCHAR(64);
