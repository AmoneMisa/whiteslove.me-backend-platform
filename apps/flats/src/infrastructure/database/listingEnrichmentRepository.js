import {pool} from './pool.js';

export async function readEnrichmentSnapshots(listings) {
  if (!listings.length) return [];
  const keys = listings.map(item => ({source: item.source, country: item.country, id: String(item.id)}));
  const {rows} = await pool.query(`
    SELECT l.data, l.last_seen_at::text AS revision
    FROM listings l
    JOIN jsonb_to_recordset($1::jsonb) AS k(source text, country text, id text)
      ON l.source = k.source AND l.country = k.country AND l.source_id = k.id
    WHERE l.active = TRUE
  `, [JSON.stringify(keys)]);
  return rows.map(row => Object.defineProperty(row.data, '_sourceRevision', {value: row.revision}));
}

export function copyEnrichmentSnapshot(listing) {
  return Object.defineProperty(structuredClone(listing), '_sourceRevision', {value: listing._sourceRevision});
}

// Enrichment is not a source observation. Never insert/reactivate a listing or
// advance last_seen_at; update only changed facts if the source is unchanged.
export async function updateListingEnrichment(original, enriched) {
  if (!original?._sourceRevision) return null;
  const patch = Object.fromEntries(Object.entries(enriched).filter(([key, value]) =>
    !['id', 'source', 'country', 'publicId', '_sourceRevision'].includes(key)
      && value !== undefined && JSON.stringify(value) !== JSON.stringify(original[key]),
  ));
  if (!Object.keys(patch).length) return null;
  const columns = {
    city: ['city', 'text'], district: ['district', 'text'], metro: ['metro', 'text'],
    address: ['address', 'text'], residenceComplex: ['residence_complex', 'text'],
    rooms: ['rooms', 'integer'], areaSqm: ['area_sqm', 'double precision'],
  };
  const assignments = Object.entries(columns).map(([key, [column, type]]) =>
    `${column} = CASE WHEN $5::jsonb ? '${key}' THEN ($5::jsonb->>'${key}')::${type} ELSE ${column} END`,
  );
  const {rows} = await pool.query(`
    UPDATE listings SET data = data || $5::jsonb, updated_at = NOW(), ${assignments.join(', ')}
    WHERE source = $1 AND country = $2 AND source_id = $3
      AND active = TRUE AND last_seen_at = $4::timestamptz
    RETURNING data
  `, [original.source, original.country, String(original.id), original._sourceRevision, JSON.stringify(patch)]);
  return rows[0]?.data || null;
}
