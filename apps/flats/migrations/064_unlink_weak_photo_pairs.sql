-- Repair only two-member clusters whose recorded evidence in every known
-- direction is ONE perceptual photo, inconsistent facts and a location conflict.
-- Preserve larger clusters, exact matches, corroborated pairs and unknown
-- evidence for review. Never turn absence of analysis into proof of a bad link.
SELECT pg_advisory_xact_lock(hashtextextended('property-cluster-merge-global', 0));

CREATE TABLE IF NOT EXISTS platform.property_cluster_repairs (
  cluster_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  previous_members JSONB NOT NULL,
  repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A cached/enqueued listing can still carry the retired cluster id. The
-- authoritative membership table must win when that stale payload is saved.
CREATE OR REPLACE FUNCTION listings_apply_property_cluster_id()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_cluster_id TEXT;
BEGIN
  SELECT cluster_id INTO v_cluster_id FROM listing_property_clusters
  WHERE source = LOWER(NEW.source) AND country = UPPER(NEW.country) AND source_id = NEW.source_id LIMIT 1;
  IF v_cluster_id IS NOT NULL THEN
    NEW.data = jsonb_set(COALESCE(NEW.data, '{}'::jsonb), '{propertyClusterId}', to_jsonb(v_cluster_id), true);
  ELSIF EXISTS (SELECT 1 FROM platform.property_cluster_repairs WHERE cluster_id = NEW.data->>'propertyClusterId') THEN
    NEW.data = jsonb_set(NEW.data - 'propertyClusterId', '{antiFake}',
      (COALESCE(NEW.data->'antiFake', '{}'::jsonb) - 'propertyCluster' - 'fingerprint')
      || '{"status":"pending","risk":"none","suspectedClone":false,"matchedListingMayBeClone":false,"conflictingClone":false,"propertyIdentityConflict":"none","reasonCodes":[]}'::jsonb
    ) || '{"duplicatePhotoRisk":"none"}'::jsonb;
  END IF;
  RETURN NEW;
END $$;

CREATE TEMP TABLE weak_photo_pair_repairs ON COMMIT DROP AS
WITH pairs AS (
  SELECT cluster_id FROM listing_property_clusters GROUP BY cluster_id HAVING count(*) = 2
), members AS (
  SELECT c.*, l.id AS listing_id, l.data
  FROM pairs p JOIN listing_property_clusters c USING (cluster_id)
  JOIN listings l ON (l.source, l.country, l.source_id) = (c.source, c.country, c.source_id)
), evidence AS (
  SELECT a.cluster_id, m AS match
  FROM members a JOIN members b ON a.cluster_id = b.cluster_id AND a.listing_id <> b.listing_id
  CROSS JOIN LATERAL jsonb_array_elements(CASE
    WHEN jsonb_typeof(a.data->'antiFake'->'cloneMatches') = 'array'
      THEN a.data->'antiFake'->'cloneMatches' ELSE '[]'::jsonb END) m
  WHERE (m->>'matchedSource', m->>'matchedCountry', m->>'matchedListingId')
    = (b.source, b.country, b.source_id)
), rejected AS (
  SELECT cluster_id FROM evidence GROUP BY cluster_id
  HAVING bool_and(match @> '{"matchedPhotoCount":1,"exactPhotoCount":0,"perceptualPhotoCount":1,"relation":{"propertyFactsConsistent":false}}'::jsonb
    AND COALESCE(match->'relation'->'locationConflict'->>'level' IN ('high', 'very_high'), false))
)
SELECT m.cluster_id, jsonb_agg(jsonb_build_object(
  'source', m.source, 'country', m.country, 'sourceId', m.source_id,
  'listingId', m.listing_id, 'antiFake', m.data->'antiFake')) AS previous_members
FROM members m JOIN rejected r USING (cluster_id)
GROUP BY m.cluster_id HAVING count(*) = 2;

INSERT INTO platform.property_cluster_repairs(cluster_id, reason, previous_members)
SELECT cluster_id, 'single_perceptual_collision_with_conflicting_facts', previous_members
FROM weak_photo_pair_repairs ON CONFLICT (cluster_id) DO NOTHING;

-- These directed claims came from the same unsupported pair. Raw photo
-- evidence remains on each listing and in the repair audit record.
DELETE FROM platform.listing_lineage e USING weak_photo_pair_repairs r
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(r.previous_members) m
  WHERE (m->>'source', m->>'country', m->>'sourceId') = (e.from_source, e.from_country, e.from_source_id))
AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.previous_members) m
  WHERE (m->>'source', m->>'country', m->>'sourceId') = (e.to_source, e.to_country, e.to_source_id));

-- The existing delete trigger removes propertyClusterId and recomputes the
-- generated dedupe key/public feed. Do this before updating cached analysis.
DELETE FROM listing_property_clusters c USING weak_photo_pair_repairs r WHERE c.cluster_id = r.cluster_id;
DELETE FROM platform.property_clusters c USING weak_photo_pair_repairs r WHERE c.cluster_id = r.cluster_id;

UPDATE listings l SET data = jsonb_set(
  l.data, '{antiFake}', (COALESCE(l.data->'antiFake', '{}'::jsonb) - 'propertyCluster' - 'fingerprint')
    || '{"status":"pending","risk":"none","suspectedClone":false,"matchedListingMayBeClone":false,"conflictingClone":false,"propertyIdentityConflict":"none","reasonCodes":[]}'::jsonb
) || '{"duplicatePhotoRisk":"none"}'::jsonb
FROM weak_photo_pair_repairs r
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(r.previous_members) m WHERE (m->>'listingId')::bigint = l.id);
-- The normal enrichment path rechecks pending analysis; no new crawl loop.
