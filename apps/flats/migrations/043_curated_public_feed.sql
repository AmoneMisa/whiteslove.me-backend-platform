-- Include curated websites in the public read model; user URLs stay private to their query.
CREATE OR REPLACE FUNCTION sync_listing_public_feed_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_room_only BOOLEAN := NEW.room_only;
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
    AND (NEW.source <> 'custom' OR NEW.data @> '{"curatedSource":true}'::jsonb)
    AND NOT NEW.commercial
    AND NEW.listing_kind <> 'propertyWanted'
    AND NEW.listing_status NOT IN ('sold', 'rented', 'closed', 'outdated')
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

UPDATE listings SET data = data WHERE source = 'custom' AND data @> '{"curatedSource":true}'::jsonb;
ANALYZE listing_public_feed_members;
