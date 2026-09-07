import {pool} from './pool.js';

function normalizedLocale(locale) {
  return String(locale || '').trim().toLowerCase().slice(0, 16);
}

function normalizedCountry(country) {
  return String(country || '').trim().toUpperCase().slice(0, 8);
}

export async function loadGeoCitySnapshot(country, city, locale = '') {
  const result = await pool.query(
    `SELECT country, city, locale, payload, source_hash, built_at
     FROM geo_city_snapshots
     WHERE country = $1 AND city = $2 AND locale = $3
     LIMIT 1;`,
    [normalizedCountry(country), String(city || '').trim(), normalizedLocale(locale)],
  );
  return result.rows[0] || null;
}

export async function listGeoCitySnapshots(locale = '') {
  const result = await pool.query(
    `SELECT country, city, locale, payload, source_hash, built_at
     FROM geo_city_snapshots
     WHERE locale = $1
     ORDER BY country, city;`,
    [normalizedLocale(locale)],
  );
  return result.rows;
}

export async function upsertGeoCitySnapshot({country, city, locale = '', payload, sourceHash}) {
  const result = await pool.query(
    `INSERT INTO geo_city_snapshots (
       country, city, locale, payload, source_hash, built_at
     )
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ON CONFLICT (country, city, locale) DO UPDATE SET
       payload = EXCLUDED.payload,
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
      JSON.stringify(payload ?? {}),
      String(sourceHash || '').slice(0, 64),
    ],
  );
  return result.rows[0] || null;
}

export async function deleteGeoCitySnapshotsNotIn(keys) {
  const normalized = (keys || []).map((key) => ({
    country: normalizedCountry(key.country),
    city: String(key.city || '').trim(),
    locale: normalizedLocale(key.locale),
  }));
  if (!normalized.length) return 0;

  const result = await pool.query(
    `DELETE FROM geo_city_snapshots snapshot
     WHERE NOT EXISTS (
       SELECT 1
       FROM jsonb_to_recordset($1::jsonb) AS keep(country TEXT, city TEXT, locale TEXT)
       WHERE keep.country = snapshot.country
         AND keep.city = snapshot.city
         AND keep.locale = snapshot.locale
     );`,
    [JSON.stringify(normalized)],
  );
  return result.rowCount;
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
