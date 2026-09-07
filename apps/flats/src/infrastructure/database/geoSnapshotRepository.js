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

function labelsMap(values, labels) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const label = labels[index] || value;
    if (label && label !== value) result[value] = label;
  }
  return result;
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

function optionsFromRow(row) {
  const options = {
    districts: row.districts || [],
    metro: row.metro || [],
    microdistricts: row.microdistricts || [],
    quartals: row.quartals || [],
    areas: row.areas || [],
  };

  if (row.locale) {
    options.districtLabels = labelsMap(options.districts, row.district_labels || []);
    options.metroLabels = labelsMap(options.metro, row.metro_labels || []);
    options.microdistrictLabels = labelsMap(
      options.microdistricts,
      row.microdistrict_labels || [],
    );
    options.quartalLabels = labelsMap(options.quartals, row.quartal_labels || []);
    options.areaLabels = labelsMap(options.areas, row.area_labels || []);
  }

  return options;
}

export async function loadGeoCityZones(country, city, locale = '') {
  const result = await pool.query(
    `SELECT country, city, locale, zones, source_hash, built_at
     FROM geo_city_snapshots
     WHERE country = $1 AND city = $2 AND locale = $3
     LIMIT 1;`,
    [normalizedCountry(country), String(city || '').trim(), normalizedLocale(locale)],
  );
  return result.rows[0] || null;
}

// /api/countries reads only compact PostgreSQL arrays. Map boundaries, POIs
// and transport geometry remain isolated in geo_city_snapshots.zones JSONB.
export async function listGeoCityOptions(locale = '') {
  const result = await pool.query(
    `SELECT
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
     FROM geo_city_options
     WHERE locale = $1
     ORDER BY country, city;`,
    [normalizedLocale(locale)],
  );
  return result.rows.map((row) => ({...row, options: optionsFromRow(row)}));
}

export async function upsertGeoCityZones({country, city, locale = '', zones, sourceHash}) {
  const result = await pool.query(
    `INSERT INTO geo_city_snapshots (
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
     RETURNING country, city, locale, source_hash, built_at;`,
    [
      normalizedCountry(country),
      String(city || '').trim(),
      normalizedLocale(locale),
      JSON.stringify(zones ?? {}),
      String(sourceHash || '').slice(0, 64),
    ],
  );
  return result.rows[0] || null;
}

export async function upsertGeoCityOptions({country, city, locale = '', options, sourceHash}) {
  const columns = optionsColumns(options);
  const result = await pool.query(
    `INSERT INTO geo_city_options (
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
       $4::text[], $5::text[],
       $6::text[], $7::text[],
       $8::text[], $9::text[],
       $10::text[], $11::text[],
       $12::text[], $13::text[],
       $14, NOW()
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
     RETURNING country, city, locale, source_hash, built_at;`,
    [
      normalizedCountry(country),
      String(city || '').trim(),
      normalizedLocale(locale),
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
      String(sourceHash || '').slice(0, 64),
    ],
  );
  return result.rows[0] || null;
}

export async function deleteGeoCityProjectionNotIn(keys) {
  const normalized = (keys || []).map((key) => ({
    country: normalizedCountry(key.country),
    city: String(key.city || '').trim(),
    locale: normalizedLocale(key.locale),
  }));
  if (!normalized.length) return {snapshots: 0, options: 0};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const args = [JSON.stringify(normalized)];
    const snapshots = await client.query(
      `DELETE FROM geo_city_snapshots snapshot
       WHERE NOT EXISTS (
         SELECT 1
         FROM jsonb_to_recordset($1::jsonb) AS keep(country TEXT, city TEXT, locale TEXT)
         WHERE keep.country = snapshot.country
           AND keep.city = snapshot.city
           AND keep.locale = snapshot.locale
       );`,
      args,
    );
    const options = await client.query(
      `DELETE FROM geo_city_options option_row
       WHERE NOT EXISTS (
         SELECT 1
         FROM jsonb_to_recordset($1::jsonb) AS keep(country TEXT, city TEXT, locale TEXT)
         WHERE keep.country = option_row.country
           AND keep.city = option_row.city
           AND keep.locale = option_row.locale
       );`,
      args,
    );
    await client.query('COMMIT');
    return {snapshots: snapshots.rowCount, options: options.rowCount};
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function withGeoSnapshotBuildLock(fn) {
  const client = await pool.connect();
  const lockId = 742_103;
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
    locked = result.rows[0]?.locked === true;
    if (!locked) return {locked: false, result: null};
    return {locked: true, result: await fn()};
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    }
    client.release();
  }
}
