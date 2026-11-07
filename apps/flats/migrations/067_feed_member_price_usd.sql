-- Store a USD price next to the original price and currency.
--
-- Sorting and filtering by price used to convert currencies inside the query
-- (CASE currency ... price / rate), so no index could serve them and every price
-- sort ordered the whole filtered set (measured 40-80 ms against 0.5 ms for the
-- date sort). The feed holds nine currencies, so a single native-currency index
-- cannot order across them either.
--
-- price/currency stay the source of truth and what a card shows. price_usd is a
-- derived sort/filter key computed from fx_rates, which a daily worker job
-- refreshes (src/support/fx-store.js), recomputing price_usd for every row.
--
-- Ordinary transaction like 040: the table is ~100k rows, so the backfill and
-- index builds are short.

CREATE TABLE IF NOT EXISTS fx_rates (
  currency       TEXT PRIMARY KEY CHECK (currency = upper(currency)),
  units_per_usd  DOUBLE PRECISION NOT NULL CHECK (units_per_usd > 0),
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same approximate table as src/support/fx.js FALLBACK. It only has to exist so
-- the backfill below works before the worker's first live refresh replaces it.
INSERT INTO fx_rates (currency, units_per_usd) VALUES
  ('USD', 1), ('EUR', 0.92), ('RON', 4.57), ('UAH', 41.5),
  ('KZT', 470), ('UZS', 12600), ('KGS', 87.5)
ON CONFLICT (currency) DO NOTHING;

ALTER TABLE listing_public_feed_members
  ADD COLUMN IF NOT EXISTS price_usd DOUBLE PRECISION;

CREATE OR REPLACE FUNCTION feed_member_price_usd(p DOUBLE PRECISION, c TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE sql STABLE
AS $$
  SELECT p / r.units_per_usd FROM fx_rates r WHERE r.currency = upper(c)
$$;

-- Fires only when price or currency is written, so it does not interfere with
-- the sync trigger's own UPDATE ... SET dedupe_key/created_at path, and the
-- daily recompute writes price_usd directly.
CREATE OR REPLACE FUNCTION set_feed_member_price_usd()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.price_usd := CASE WHEN NEW.price IS NULL THEN NULL
                        ELSE feed_member_price_usd(NEW.price, NEW.currency) END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listing_public_feed_members_price_usd ON listing_public_feed_members;
CREATE TRIGGER listing_public_feed_members_price_usd
  BEFORE INSERT OR UPDATE OF price, currency ON listing_public_feed_members
  FOR EACH ROW EXECUTE FUNCTION set_feed_member_price_usd();

-- Ascending and descending need separate indexes: both sort NULLs last, and a
-- backward scan of the ascending index would put them first.
CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_price_usd_asc_idx
  ON listing_public_feed_members (country, city, deal_type, price_usd ASC NULLS LAST, listing_id ASC)
  INCLUDE (freshness_at, created_at)
  WHERE is_canonical;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_city_price_usd_desc_idx
  ON listing_public_feed_members (country, city, deal_type, price_usd DESC NULLS LAST, listing_id DESC)
  INCLUDE (freshness_at, created_at)
  WHERE is_canonical;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_country_price_usd_asc_idx
  ON listing_public_feed_members (country, deal_type, price_usd ASC NULLS LAST, listing_id ASC)
  INCLUDE (freshness_at, city)
  WHERE is_canonical;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_canonical_country_price_usd_desc_idx
  ON listing_public_feed_members (country, deal_type, price_usd DESC NULLS LAST, listing_id DESC)
  INCLUDE (freshness_at, city)
  WHERE is_canonical;

-- Backfill AFTER the index builds, not before. Updating rows first and building
-- indexes in the same transaction marks them indcheckxmin, and the planner then
-- refuses to use them until older snapshots are gone; measured on a copy of
-- production data, the ordered scans below only appear when this runs last.
UPDATE listing_public_feed_members
SET price_usd = feed_member_price_usd(price, currency)
WHERE price IS NOT NULL;
