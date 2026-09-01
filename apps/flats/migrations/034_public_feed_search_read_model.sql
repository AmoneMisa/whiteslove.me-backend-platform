-- Expand the compact public-feed membership table into the structured-search
-- read model used by the ordinary listing UI. Keep the wide JSONB payload in
-- listings; materialize only values that participate in filters, dedupe or
-- pagination so common searches do not have to rank the full listings heap.

ALTER TABLE listing_public_feed_members
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS property_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS district TEXT,
  ADD COLUMN IF NOT EXISTS metro TEXT,
  ADD COLUMN IF NOT EXISTS by_agency BOOLEAN,
  ADD COLUMN IF NOT EXISTS price DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(16),
  ADD COLUMN IF NOT EXISTS rooms INTEGER,
  ADD COLUMN IF NOT EXISTS area_sqm DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS bedrooms DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS floor_number DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS total_floors DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS building_year DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS commission_percent DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS metro_distance_m DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS audience TEXT,
  ADD COLUMN IF NOT EXISTS room_only BOOLEAN,
  ADD COLUMN IF NOT EXISTS new_building BOOLEAN,
  ADD COLUMN IF NOT EXISTS dishwasher BOOLEAN,
  ADD COLUMN IF NOT EXISTS air_conditioner BOOLEAN,
  ADD COLUMN IF NOT EXISTS parking BOOLEAN,
  ADD COLUMN IF NOT EXISTS internet BOOLEAN,
  ADD COLUMN IF NOT EXISTS gas BOOLEAN,
  ADD COLUMN IF NOT EXISTS balcony BOOLEAN,
  ADD COLUMN IF NOT EXISTS terrace BOOLEAN,
  ADD COLUMN IF NOT EXISTS private_yard BOOLEAN,
  ADD COLUMN IF NOT EXISTS pets_allowed BOOLEAN,
  ADD COLUMN IF NOT EXISTS children_allowed BOOLEAN,
  ADD COLUMN IF NOT EXISTS tv BOOLEAN,
  ADD COLUMN IF NOT EXISTS microwave BOOLEAN,
  ADD COLUMN IF NOT EXISTS oven BOOLEAN,
  ADD COLUMN IF NOT EXISTS bidet BOOLEAN,
  ADD COLUMN IF NOT EXISTS walk_in_closet BOOLEAN,
  ADD COLUMN IF NOT EXISTS bathtub BOOLEAN,
  ADD COLUMN IF NOT EXISTS shower BOOLEAN,
  ADD COLUMN IF NOT EXISTS euro_layout BOOLEAN,
  ADD COLUMN IF NOT EXISTS elevator BOOLEAN,
  ADD COLUMN IF NOT EXISTS deposit BOOLEAN,
  ADD COLUMN IF NOT EXISTS communal_separated BOOLEAN,
  ADD COLUMN IF NOT EXISTS commission BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_photos BOOLEAN;

UPDATE listing_public_feed_members AS m
SET
  source = l.source,
  source_id = l.source_id,
  property_type = l.property_type,
  deal_type = l.deal_type,
  city = l.city,
  district = l.district,
  metro = l.metro,
  by_agency = l.by_agency,
  price = l.price,
  currency = l.currency,
  rooms = l.rooms,
  area_sqm = l.area_sqm,
  bedrooms = l.bedrooms,
  floor_number = l.floor_number,
  total_floors = l.total_floors,
  building_year = l.building_year,
  commission_percent = l.commission_percent,
  metro_distance_m = l.metro_distance_m,
  lat = l.lat,
  lng = l.lng,
  audience = NULLIF(BTRIM(l.data->>'audience'), ''),
  room_only = CASE WHEN jsonb_typeof(l.data->'roomOnly') = 'boolean' THEN (l.data->>'roomOnly')::boolean ELSE NULL END,
  new_building = CASE WHEN jsonb_typeof(l.data->'newBuilding') = 'boolean' THEN (l.data->>'newBuilding')::boolean ELSE NULL END,
  dishwasher = CASE WHEN jsonb_typeof(l.data->'dishwasher') = 'boolean' THEN (l.data->>'dishwasher')::boolean ELSE NULL END,
  air_conditioner = CASE WHEN jsonb_typeof(l.data->'airConditioner') = 'boolean' THEN (l.data->>'airConditioner')::boolean ELSE NULL END,
  parking = CASE WHEN jsonb_typeof(l.data->'parking') = 'boolean' THEN (l.data->>'parking')::boolean ELSE NULL END,
  internet = CASE WHEN jsonb_typeof(l.data->'internet') = 'boolean' THEN (l.data->>'internet')::boolean ELSE NULL END,
  gas = CASE WHEN jsonb_typeof(l.data->'gas') = 'boolean' THEN (l.data->>'gas')::boolean ELSE NULL END,
  balcony = CASE WHEN jsonb_typeof(l.data->'balcony') = 'boolean' THEN (l.data->>'balcony')::boolean ELSE NULL END,
  terrace = CASE WHEN jsonb_typeof(l.data->'terrace') = 'boolean' THEN (l.data->>'terrace')::boolean ELSE NULL END,
  private_yard = CASE WHEN jsonb_typeof(l.data->'privateYard') = 'boolean' THEN (l.data->>'privateYard')::boolean ELSE NULL END,
  pets_allowed = CASE WHEN jsonb_typeof(l.data->'petsAllowed') = 'boolean' THEN (l.data->>'petsAllowed')::boolean ELSE NULL END,
  children_allowed = CASE WHEN jsonb_typeof(l.data->'childrenAllowed') = 'boolean' THEN (l.data->>'childrenAllowed')::boolean ELSE NULL END,
  tv = CASE WHEN jsonb_typeof(l.data->'tv') = 'boolean' THEN (l.data->>'tv')::boolean ELSE NULL END,
  microwave = CASE WHEN jsonb_typeof(l.data->'microwave') = 'boolean' THEN (l.data->>'microwave')::boolean ELSE NULL END,
  oven = CASE WHEN jsonb_typeof(l.data->'oven') = 'boolean' THEN (l.data->>'oven')::boolean ELSE NULL END,
  bidet = CASE WHEN jsonb_typeof(l.data->'bidet') = 'boolean' THEN (l.data->>'bidet')::boolean ELSE NULL END,
  walk_in_closet = CASE WHEN jsonb_typeof(l.data->'walkInCloset') = 'boolean' THEN (l.data->>'walkInCloset')::boolean ELSE NULL END,
  bathtub = CASE WHEN jsonb_typeof(l.data->'bathtub') = 'boolean' THEN (l.data->>'bathtub')::boolean ELSE NULL END,
  shower = CASE WHEN jsonb_typeof(l.data->'shower') = 'boolean' THEN (l.data->>'shower')::boolean ELSE NULL END,
  euro_layout = CASE WHEN jsonb_typeof(l.data->'euroLayout') = 'boolean' THEN (l.data->>'euroLayout')::boolean ELSE NULL END,
  elevator = CASE WHEN jsonb_typeof(l.data->'elevator') = 'boolean' THEN (l.data->>'elevator')::boolean ELSE NULL END,
  deposit = CASE WHEN jsonb_typeof(l.data->'deposit') = 'boolean' THEN (l.data->>'deposit')::boolean ELSE NULL END,
  communal_separated = CASE WHEN jsonb_typeof(l.data->'communalSeparated') = 'boolean' THEN (l.data->>'communalSeparated')::boolean ELSE NULL END,
  commission = CASE WHEN jsonb_typeof(l.data->'commission') = 'boolean' THEN (l.data->>'commission')::boolean ELSE NULL END,
  has_photos = (
    COALESCE(NULLIF(BTRIM(l.data->>'photo'), ''), '') <> ''
    OR JSONB_ARRAY_LENGTH(CASE WHEN jsonb_typeof(l.data->'photos') = 'array' THEN l.data->'photos' ELSE '[]'::jsonb END) > 0
  )
FROM listings AS l
WHERE l.id = m.listing_id;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_city_deal_fresh_idx
  ON listing_public_feed_members(country, city, deal_type, freshness_at DESC, dedupe_key, listing_id DESC);

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_deal_owner_fresh_idx
  ON listing_public_feed_members(country, deal_type, by_agency, freshness_at DESC, dedupe_key, listing_id DESC);

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_deal_price_idx
  ON listing_public_feed_members(country, deal_type, currency, price, listing_id)
  WHERE price IS NOT NULL;

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_source_fresh_idx
  ON listing_public_feed_members(country, source, freshness_at DESC, dedupe_key, listing_id DESC);

CREATE INDEX IF NOT EXISTS listing_public_feed_members_country_lat_lng_idx
  ON listing_public_feed_members(country, lat, lng, listing_id)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_listing_public_feed_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_room_only BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'roomOnly') = 'boolean' THEN (NEW.data->>'roomOnly')::boolean ELSE NULL END;
  v_new_building BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'newBuilding') = 'boolean' THEN (NEW.data->>'newBuilding')::boolean ELSE NULL END;
  v_dishwasher BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'dishwasher') = 'boolean' THEN (NEW.data->>'dishwasher')::boolean ELSE NULL END;
  v_air_conditioner BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'airConditioner') = 'boolean' THEN (NEW.data->>'airConditioner')::boolean ELSE NULL END;
  v_parking BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'parking') = 'boolean' THEN (NEW.data->>'parking')::boolean ELSE NULL END;
  v_internet BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'internet') = 'boolean' THEN (NEW.data->>'internet')::boolean ELSE NULL END;
  v_gas BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'gas') = 'boolean' THEN (NEW.data->>'gas')::boolean ELSE NULL END;
  v_balcony BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'balcony') = 'boolean' THEN (NEW.data->>'balcony')::boolean ELSE NULL END;
  v_terrace BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'terrace') = 'boolean' THEN (NEW.data->>'terrace')::boolean ELSE NULL END;
  v_private_yard BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'privateYard') = 'boolean' THEN (NEW.data->>'privateYard')::boolean ELSE NULL END;
  v_pets_allowed BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'petsAllowed') = 'boolean' THEN (NEW.data->>'petsAllowed')::boolean ELSE NULL END;
  v_children_allowed BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'childrenAllowed') = 'boolean' THEN (NEW.data->>'childrenAllowed')::boolean ELSE NULL END;
  v_tv BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'tv') = 'boolean' THEN (NEW.data->>'tv')::boolean ELSE NULL END;
  v_microwave BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'microwave') = 'boolean' THEN (NEW.data->>'microwave')::boolean ELSE NULL END;
  v_oven BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'oven') = 'boolean' THEN (NEW.data->>'oven')::boolean ELSE NULL END;
  v_bidet BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'bidet') = 'boolean' THEN (NEW.data->>'bidet')::boolean ELSE NULL END;
  v_walk_in_closet BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'walkInCloset') = 'boolean' THEN (NEW.data->>'walkInCloset')::boolean ELSE NULL END;
  v_bathtub BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'bathtub') = 'boolean' THEN (NEW.data->>'bathtub')::boolean ELSE NULL END;
  v_shower BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'shower') = 'boolean' THEN (NEW.data->>'shower')::boolean ELSE NULL END;
  v_euro_layout BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'euroLayout') = 'boolean' THEN (NEW.data->>'euroLayout')::boolean ELSE NULL END;
  v_elevator BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'elevator') = 'boolean' THEN (NEW.data->>'elevator')::boolean ELSE NULL END;
  v_deposit BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'deposit') = 'boolean' THEN (NEW.data->>'deposit')::boolean ELSE NULL END;
  v_communal_separated BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'communalSeparated') = 'boolean' THEN (NEW.data->>'communalSeparated')::boolean ELSE NULL END;
  v_commission BOOLEAN := CASE WHEN jsonb_typeof(NEW.data->'commission') = 'boolean' THEN (NEW.data->>'commission')::boolean ELSE NULL END;
  v_has_photos BOOLEAN := (
    COALESCE(NULLIF(BTRIM(NEW.data->>'photo'), ''), '') <> ''
    OR JSONB_ARRAY_LENGTH(CASE WHEN jsonb_typeof(NEW.data->'photos') = 'array' THEN NEW.data->'photos' ELSE '[]'::jsonb END) > 0
  );
BEGIN
  IF NEW.active = TRUE
    AND NEW.source <> 'custom'
    AND NOT (NEW.data @> '{"commercial":true}'::jsonb)
    AND COALESCE(NEW.data->>'listingKind', 'propertyOffer') <> 'propertyWanted'
    AND COALESCE(NEW.data->>'listingStatus', 'active') NOT IN ('sold', 'rented', 'closed', 'outdated')
  THEN
    INSERT INTO listing_public_feed_members (
      listing_id, dedupe_key, country, source, source_id, property_type, deal_type,
      city, district, metro, by_agency, price, currency, rooms, area_sqm,
      bedrooms, floor_number, total_floors, building_year, commission_percent,
      metro_distance_m, lat, lng, audience, room_only, new_building, dishwasher,
      air_conditioner, parking, internet, gas, balcony, terrace, private_yard,
      pets_allowed, children_allowed, tv, microwave, oven, bidet, walk_in_closet,
      bathtub, shower, euro_layout, elevator, deposit, communal_separated,
      commission, has_photos, created_at, first_seen_at, freshness_at
    ) VALUES (
      NEW.id, NEW.dedupe_key, NEW.country, NEW.source, NEW.source_id, NEW.property_type, NEW.deal_type,
      NEW.city, NEW.district, NEW.metro, NEW.by_agency, NEW.price, NEW.currency, NEW.rooms, NEW.area_sqm,
      NEW.bedrooms, NEW.floor_number, NEW.total_floors, NEW.building_year, NEW.commission_percent,
      NEW.metro_distance_m, NEW.lat, NEW.lng, NULLIF(BTRIM(NEW.data->>'audience'), ''),
      v_room_only, v_new_building, v_dishwasher, v_air_conditioner, v_parking,
      v_internet, v_gas, v_balcony, v_terrace, v_private_yard, v_pets_allowed,
      v_children_allowed, v_tv, v_microwave, v_oven, v_bidet, v_walk_in_closet,
      v_bathtub, v_shower, v_euro_layout, v_elevator, v_deposit,
      v_communal_separated, v_commission, v_has_photos,
      NEW.created_at, NEW.first_seen_at, COALESCE(NEW.created_at, NEW.first_seen_at)
    )
    ON CONFLICT (listing_id) DO UPDATE SET
      dedupe_key = EXCLUDED.dedupe_key,
      country = EXCLUDED.country,
      source = EXCLUDED.source,
      source_id = EXCLUDED.source_id,
      property_type = EXCLUDED.property_type,
      deal_type = EXCLUDED.deal_type,
      city = EXCLUDED.city,
      district = EXCLUDED.district,
      metro = EXCLUDED.metro,
      by_agency = EXCLUDED.by_agency,
      price = EXCLUDED.price,
      currency = EXCLUDED.currency,
      rooms = EXCLUDED.rooms,
      area_sqm = EXCLUDED.area_sqm,
      bedrooms = EXCLUDED.bedrooms,
      floor_number = EXCLUDED.floor_number,
      total_floors = EXCLUDED.total_floors,
      building_year = EXCLUDED.building_year,
      commission_percent = EXCLUDED.commission_percent,
      metro_distance_m = EXCLUDED.metro_distance_m,
      lat = EXCLUDED.lat,
      lng = EXCLUDED.lng,
      audience = EXCLUDED.audience,
      room_only = EXCLUDED.room_only,
      new_building = EXCLUDED.new_building,
      dishwasher = EXCLUDED.dishwasher,
      air_conditioner = EXCLUDED.air_conditioner,
      parking = EXCLUDED.parking,
      internet = EXCLUDED.internet,
      gas = EXCLUDED.gas,
      balcony = EXCLUDED.balcony,
      terrace = EXCLUDED.terrace,
      private_yard = EXCLUDED.private_yard,
      pets_allowed = EXCLUDED.pets_allowed,
      children_allowed = EXCLUDED.children_allowed,
      tv = EXCLUDED.tv,
      microwave = EXCLUDED.microwave,
      oven = EXCLUDED.oven,
      bidet = EXCLUDED.bidet,
      walk_in_closet = EXCLUDED.walk_in_closet,
      bathtub = EXCLUDED.bathtub,
      shower = EXCLUDED.shower,
      euro_layout = EXCLUDED.euro_layout,
      elevator = EXCLUDED.elevator,
      deposit = EXCLUDED.deposit,
      communal_separated = EXCLUDED.communal_separated,
      commission = EXCLUDED.commission,
      has_photos = EXCLUDED.has_photos,
      created_at = EXCLUDED.created_at,
      first_seen_at = EXCLUDED.first_seen_at,
      freshness_at = EXCLUDED.freshness_at
    WHERE ROW(
      listing_public_feed_members.dedupe_key,
      listing_public_feed_members.country,
      listing_public_feed_members.source,
      listing_public_feed_members.source_id,
      listing_public_feed_members.property_type,
      listing_public_feed_members.deal_type,
      listing_public_feed_members.city,
      listing_public_feed_members.district,
      listing_public_feed_members.metro,
      listing_public_feed_members.by_agency,
      listing_public_feed_members.price,
      listing_public_feed_members.currency,
      listing_public_feed_members.rooms,
      listing_public_feed_members.area_sqm,
      listing_public_feed_members.bedrooms,
      listing_public_feed_members.floor_number,
      listing_public_feed_members.total_floors,
      listing_public_feed_members.building_year,
      listing_public_feed_members.commission_percent,
      listing_public_feed_members.metro_distance_m,
      listing_public_feed_members.lat,
      listing_public_feed_members.lng,
      listing_public_feed_members.audience,
      listing_public_feed_members.room_only,
      listing_public_feed_members.new_building,
      listing_public_feed_members.dishwasher,
      listing_public_feed_members.air_conditioner,
      listing_public_feed_members.parking,
      listing_public_feed_members.internet,
      listing_public_feed_members.gas,
      listing_public_feed_members.balcony,
      listing_public_feed_members.terrace,
      listing_public_feed_members.private_yard,
      listing_public_feed_members.pets_allowed,
      listing_public_feed_members.children_allowed,
      listing_public_feed_members.tv,
      listing_public_feed_members.microwave,
      listing_public_feed_members.oven,
      listing_public_feed_members.bidet,
      listing_public_feed_members.walk_in_closet,
      listing_public_feed_members.bathtub,
      listing_public_feed_members.shower,
      listing_public_feed_members.euro_layout,
      listing_public_feed_members.elevator,
      listing_public_feed_members.deposit,
      listing_public_feed_members.communal_separated,
      listing_public_feed_members.commission,
      listing_public_feed_members.has_photos,
      listing_public_feed_members.created_at,
      listing_public_feed_members.first_seen_at,
      listing_public_feed_members.freshness_at
    ) IS DISTINCT FROM ROW(
      EXCLUDED.dedupe_key, EXCLUDED.country, EXCLUDED.source, EXCLUDED.source_id,
      EXCLUDED.property_type, EXCLUDED.deal_type, EXCLUDED.city, EXCLUDED.district,
      EXCLUDED.metro, EXCLUDED.by_agency, EXCLUDED.price, EXCLUDED.currency,
      EXCLUDED.rooms, EXCLUDED.area_sqm, EXCLUDED.bedrooms, EXCLUDED.floor_number,
      EXCLUDED.total_floors, EXCLUDED.building_year, EXCLUDED.commission_percent,
      EXCLUDED.metro_distance_m, EXCLUDED.lat, EXCLUDED.lng, EXCLUDED.audience,
      EXCLUDED.room_only, EXCLUDED.new_building, EXCLUDED.dishwasher,
      EXCLUDED.air_conditioner, EXCLUDED.parking, EXCLUDED.internet, EXCLUDED.gas,
      EXCLUDED.balcony, EXCLUDED.terrace, EXCLUDED.private_yard, EXCLUDED.pets_allowed,
      EXCLUDED.children_allowed, EXCLUDED.tv, EXCLUDED.microwave, EXCLUDED.oven,
      EXCLUDED.bidet, EXCLUDED.walk_in_closet, EXCLUDED.bathtub, EXCLUDED.shower,
      EXCLUDED.euro_layout, EXCLUDED.elevator, EXCLUDED.deposit,
      EXCLUDED.communal_separated, EXCLUDED.commission, EXCLUDED.has_photos,
      EXCLUDED.created_at, EXCLUDED.first_seen_at, EXCLUDED.freshness_at
    );
  ELSE
    DELETE FROM listing_public_feed_members WHERE listing_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_sync_public_feed_member ON listings;
CREATE TRIGGER listings_sync_public_feed_member
AFTER INSERT OR UPDATE OF
  source,
  country,
  source_id,
  title,
  description,
  property_type,
  deal_type,
  city,
  district,
  metro,
  price,
  currency,
  rooms,
  area_sqm,
  by_agency,
  data,
  active,
  created_at,
  first_seen_at
ON listings
FOR EACH ROW
EXECUTE FUNCTION sync_listing_public_feed_member();

ANALYZE listing_public_feed_members;
