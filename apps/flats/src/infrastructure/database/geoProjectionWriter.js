import {pool} from './pool.js';

function normalizedLocale(locale) {
  return String(locale || '').trim().toLowerCase().slice(0, 16);
}

function normalizedCountry(country) {
  return String(country || '').trim().toUpperCase().slice(0, 8);
}

function normalizedValues(values) {
  return (values || []).map((value) => String(value || '').trim()).filter(Boolean);
}

function labelValues(values, labels) {
  const map = labels && typeof labels === 'object' ? labels : {};
  return values.map((value) => String(map[value] || value));
}

function optionsColumns(options = {}) {
  const districts = normalizedValues(options.districts);
  const metro = normalizedValues(options.metro);
  const microdistricts = normalizedValues(options.microdistricts);
  const quartals = normalizedValues(options.quartals);
  const areas = normalizedValues(options.areas);
  return {
    districts,
    districtLabels: labelValues(districts, options.districtLabels),
    metro,
    metroLabels: labelValues(metro, options.metroLabels),
    microdistricts,
    microdistrictLabels: labelValues(microdistricts, options.microdistrictLabels),
    quartals,
    quartalLabels: labelValues(quartals, options.quartalLabels),
    areas,
    areaLabels: labelValues(areas, options.areaLabels),
  };
}

function normalizedProjectionKeys(keys) {
  return (keys || [])
    .map((key) => ({
      country: normalizedCountry(key.country),
      city: String(key.city || '').trim(),
      locale: normalizedLocale(key.locale),
      zonesHash: String(key.zonesHash || '').slice(0, 64),
      optionsHash: String(key.optionsHash || '').slice(0, 64),
    }))
    .filter((key) => key.country && key.city && key.zonesHash && key.optionsHash);
}

// One data-modifying CTE statement owns both tables. PostgreSQL executes the
// whole statement atomically, so readers can never observe a new map snapshot
// paired with selector arrays from the previous build (or vice versa).
export async function upsertGeoCityProjection({
  country,
  city,
  locale = '',
  zones,
  zonesSourceHash,
  options,
  optionsSourceHash,
}) {
  const columns = optionsColumns(options);
  const result = await pool.query(
    `WITH zones_upsert AS (
       INSERT INTO geo_city_snapshots (
         country, city, locale, zones, source_hash, built_at
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (country, city, locale) DO UPDATE SET
         zones = EXCLUDED.zones,
         source_hash = EXCLUDED.source_hash,
         built_at = CASE
           WHEN geo_city_snapshots.source_hash IS DISTINCT FROM EXCLUDED.source_hash
             THEN NOW()
           ELSE geo_city_snapshots.built_at
         END
       RETURNING source_hash, built_at
     ), options_upsert AS (
       INSERT INTO geo_city_options (
         country,
         city,
         locale,
         districts,
         district_labels,
         metro,
         metro_labels,
         microdistricts,
         microdistrict_labels,
         quartals,
         quartal_labels,
         areas,
         area_labels,
         source_hash,
         built_at
       )
       VALUES (
         $1, $2, $3,
         $6::text[], $7::text[],
         $8::text[], $9::text[],
         $10::text[], $11::text[],
         $12::text[], $13::text[],
         $14::text[], $15::text[],
         $16, NOW()
       )
       ON CONFLICT (country, city, locale) DO UPDATE SET
         districts = EXCLUDED.districts,
         district_labels = EXCLUDED.district_labels,
         metro = EXCLUDED.metro,
         metro_labels = EXCLUDED.metro_labels,
         microdistricts = EXCLUDED.microdistricts,
         microdistrict_labels = EXCLUDED.microdistrict_labels,
         quartals = EXCLUDED.quartals,
         quartal_labels = EXCLUDED.quartal_labels,
         areas = EXCLUDED.areas,
         area_labels = EXCLUDED.area_labels,
         source_hash = EXCLUDED.source_hash,
         built_at = CASE
           WHEN geo_city_options.source_hash IS DISTINCT FROM EXCLUDED.source_hash
             THEN NOW()
           ELSE geo_city_options.built_at
         END
       RETURNING source_hash, built_at
     )
     SELECT
       zones_upsert.source_hash AS zones_source_hash,
       zones_upsert.built_at AS zones_built_at,
       options_upsert.source_hash AS options_source_hash,
       options_upsert.built_at AS options_built_at
     FROM zones_upsert
     CROSS JOIN options_upsert;`,
    [
      normalizedCountry(country),
      String(city || '').trim(),
      normalizedLocale(locale),
      JSON.stringify(zones ?? {}),
      String(zonesSourceHash || '').slice(0, 64),
      columns.districts,
      columns.districtLabels,
      columns.metro,
      columns.metroLabels,
      columns.microdistricts,
      columns.microdistrictLabels,
      columns.quartals,
      columns.quartalLabels,
      columns.areas,
      columns.areaLabels,
      String(optionsSourceHash || '').slice(0, 64),
    ],
  );
  return result.rows[0] || null;
}

// Deployment verification checks not only that both rows exist, but that both
// contain the exact hashes produced by this prewarm. A stale half-projection
// therefore cannot satisfy the cutover gate.
export async function verifyGeoCityProjectionVersions(keys) {
  const normalized = normalizedProjectionKeys(keys);
  if (!normalized.length) {
    return {expected: 0, snapshots: 0, options: 0, missing: []};
  }

  const result = await pool.query(
    `WITH expected AS (
       SELECT DISTINCT country, city, locale, zones_hash, options_hash
       FROM jsonb_to_recordset($1::jsonb) AS item(
         country TEXT,
         city TEXT,
         locale TEXT,
         zones_hash TEXT,
         options_hash TEXT
       )
     ), coverage AS (
       SELECT
         expected.country,
         expected.city,
         expected.locale,
         snapshot.country IS NOT NULL
           AND snapshot.source_hash = expected.zones_hash AS has_snapshot,
         option_row.country IS NOT NULL
           AND option_row.source_hash = expected.options_hash AS has_options
       FROM expected
       LEFT JOIN geo_city_snapshots snapshot
         USING (country, city, locale)
       LEFT JOIN geo_city_options option_row
         USING (country, city, locale)
     )
     SELECT
       COUNT(*)::integer AS expected,
       COUNT(*) FILTER (WHERE has_snapshot)::integer AS snapshots,
       COUNT(*) FILTER (WHERE has_options)::integer AS options,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'country', country,
             'city', city,
             'locale', locale,
             'snapshot', has_snapshot,
             'options', has_options
           )
         ) FILTER (WHERE NOT has_snapshot OR NOT has_options),
         '[]'::jsonb
       ) AS missing
     FROM coverage;`,
    [JSON.stringify(normalized.map((key) => ({
      country: key.country,
      city: key.city,
      locale: key.locale,
      zones_hash: key.zonesHash,
      options_hash: key.optionsHash,
    })))],
  );

  const row = result.rows[0] || {};
  return {
    expected: Number(row.expected || 0),
    snapshots: Number(row.snapshots || 0),
    options: Number(row.options || 0),
    missing: Array.isArray(row.missing) ? row.missing : [],
  };
}
