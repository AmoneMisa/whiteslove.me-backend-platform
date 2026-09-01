ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS street TEXT
    GENERATED ALWAYS AS (NULLIF(BTRIM(data ->> 'street'), '')) STORED,
  ADD COLUMN IF NOT EXISTS house_number TEXT
    GENERATED ALWAYS AS (NULLIF(BTRIM(data ->> 'houseNumber'), '')) STORED,
  ADD COLUMN IF NOT EXISTS building TEXT
    GENERATED ALWAYS AS (NULLIF(BTRIM(data ->> 'building'), '')) STORED;

CREATE INDEX IF NOT EXISTS idx_listings_country_city_street
  ON listings (country, city, street)
  WHERE street IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listings_exact_address_parts
  ON listings (country, city, street, house_number, building)
  WHERE street IS NOT NULL AND house_number IS NOT NULL;
