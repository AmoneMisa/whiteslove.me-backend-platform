// Points of interest, stored once per city so coordinate enrichment costs a
// query instead of a network call per listing.
//
// The alternative — asking Overpass/Nominatim what is near each listing — is
// thousands of rate-limited calls per refresh for data that changes about as
// often as a city gets a new metro line. One city-wide pull fills this table,
// and every listing after that is arithmetic over rows already in memory.

import {pool} from './pool.js';

function boundedText(value, max, fallback = null) {
  if (value == null) return fallback;
  return String(value).slice(0, max);
}

function normalizedPlace(row) {
  return {
    ...row,
    country: boundedText(String(row?.country || '').toUpperCase(), 8, ''),
    city: boundedText(row?.city || '', 160, ''),
    kind: boundedText(row?.kind || '', 32, ''),
    name: boundedText(row?.name || '', 255, ''),
    name_ru: boundedText(row?.name_ru ?? row?.nameRu, 255),
    source: boundedText(row?.source || '', 16, ''),
    // Upstream-owned identifiers remain unbounded TEXT in PostgreSQL.
    external_id: String(row?.external_id ?? row?.externalId ?? ''),
  };
}

const UPSERT_SQL = `
  INSERT INTO places (country, city, kind, name, name_ru, lat, lng, source, external_id, tags, updated_at)
  SELECT input.country, input.city, input.kind, input.name, input.name_ru,
         input.lat, input.lng, input.source, input.external_id, input.tags, NOW()
  FROM jsonb_to_recordset($1::jsonb) AS input (
    country TEXT, city TEXT, kind TEXT, name TEXT, name_ru TEXT,
    lat DOUBLE PRECISION, lng DOUBLE PRECISION, source TEXT, external_id TEXT, tags JSONB
  )
  WHERE input.name <> '' AND input.lat IS NOT NULL AND input.lng IS NOT NULL
  ON CONFLICT (country, kind, source, external_id) DO UPDATE SET
    city = EXCLUDED.city,
    name = EXCLUDED.name,
    name_ru = EXCLUDED.name_ru,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    tags = EXCLUDED.tags,
    updated_at = NOW();
`;

export async function upsertPlaces(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;

  let saved = 0;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500).map(normalizedPlace);
    await pool.query(UPSERT_SQL, [JSON.stringify(batch)]);
    saved += batch.length;
  }
  return saved;
}

/** Every place in a city, for one in-memory pass over a batch of listings. */
export async function loadCityPlaces(country, city) {
  const result = await pool.query(
    `SELECT kind, name, name_ru, lat, lng
     FROM places
     WHERE country = $1 AND ($2 = '' OR city = $2);`,
    [boundedText(String(country || '').toUpperCase(), 8, ''), boundedText(city || '', 160, '')],
  );

  return result.rows.map((row) => ({
    kind: row.kind,
    name: row.name,
    nameRu: row.name_ru || null,
    lat: Number(row.lat),
    lng: Number(row.lng),
  }));
}

/** When each city was last filled, so a sync can decide whether to run. */
export async function placesFreshness() {
  const result = await pool.query(
    `SELECT country, city, kind, COUNT(*)::int AS count, MAX(updated_at) AS updated_at
     FROM places GROUP BY country, city, kind ORDER BY country, city, kind;`,
  );
  return result.rows;
}

// Kept for callers that historically owned a dedicated places pool. Places now
// shares the process-wide backend pool, whose lifecycle is owned by db.js.
export async function closePlacesDb() {}
