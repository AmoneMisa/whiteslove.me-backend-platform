// Background sweep that feeds already-stored listings to the amenity enrichment.
//
// Enrichment used to run only on the listings of a crawl page that was just
// persisted, so an advert the crawler had already stored was never looked at
// again until its source page happened to be re-crawled. This sweeps the stored
// corpus instead, newest advert first, in batches (one rate-limited request per
// batch), sized to the free capacity of the shared submit queue so it never
// competes with crawl-time enrichment for slots.

import { COUNTRIES } from '../geo/countries.js';
import { pool } from '../infrastructure/database/pool.js';
import { aiTextCapacity } from '../support/ai-worker.js';
import { persistAiMerged } from '../scheduling/queueTasks.js';
import {
  AMENITY_BATCH_SIZE,
  AMENITY_FLAG_FIELDS,
  AMENITY_PASS_VERSION,
  MIN_AMENITY_TEXT_CHARS,
  needsAmenityPass,
  scheduleAmenityBatch,
} from './amenity-batch.js';

const COOLDOWN_MS = (Number(process.env.AI_BACKFILL_COOLDOWN_MINUTES) || 30) * 60_000;

// listing key -> time before which it is not offered again. A listing the model
// skipped, or whose request failed, would otherwise sit at the head of the
// newest-first ordering and be re-submitted on every tick.
const cooldown = new Map();

function pruneCooldown(now) {
  for (const [key, until] of cooldown) if (until <= now) cooldown.delete(key);
}

const blankSql = (field) => `(l.data->>'${field}') IS NULL OR (l.data->>'${field}') = ''`;

/** Stored listings with unknown amenities and enough text, newest advert first. */
export async function readAmenityBackfillCandidates({ limit, excludeKeys = new Set() }) {
  const { rows } = await pool.query(`
    SELECT l.data, l.last_seen_at::text AS revision, l.country
    FROM listings l
    WHERE l.active = TRUE
      AND l.country = ANY($1::text[])
      AND l.source NOT LIKE 'mock%'
      AND LENGTH(BTRIM(COALESCE(l.title, '') || E'\\n' || COALESCE(l.description, ''))) >= $3
      AND COALESCE(l.data->'ai'->>'amenityPass', '') <> $2
      AND (${AMENITY_FLAG_FIELDS.map(blankSql).join(' OR ')})
      AND (l.source || ':' || l.source_id) <> ALL($5::text[])
    ORDER BY COALESCE(l.created_at, l.first_seen_at) DESC
    LIMIT $4
  `, [
    Object.keys(COUNTRIES),
    AMENITY_PASS_VERSION,
    MIN_AMENITY_TEXT_CHARS,
    // Headroom for rows the JS-side check still rejects.
    limit * 2,
    [...excludeKeys],
  ]);

  const out = [];
  for (const row of rows) {
    const listing = Object.defineProperty(row.data, '_sourceRevision', { value: row.revision });
    if (excludeKeys.has(`${listing.source}:${listing.id}`) || !needsAmenityPass(listing)) continue;
    out.push({ listing, country: row.country });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One sweep tick. Each free queue slot carries one batch, so a tick submits at
 * most `free * AMENITY_BATCH_SIZE` listings. Returns the number of batches queued.
 */
export async function runAiBackfillTick({ now = Date.now() } = {}) {
  const free = aiTextCapacity();
  if (free <= 0) return 0;
  pruneCooldown(now);

  const candidates = await readAmenityBackfillCandidates({
    limit: free * AMENITY_BATCH_SIZE,
    excludeKeys: new Set(cooldown.keys()),
  });
  if (!candidates.length) return 0;

  // A batch is one request, so it must not mix countries: the city/country
  // context in `meta` and the persistence config are per country.
  const byCountry = new Map();
  for (const { listing, country } of candidates) {
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push(listing);
  }

  let queuedBatches = 0;
  for (const [country, listings] of byCountry) {
    const config = COUNTRIES[country];
    if (!config) continue;
    for (let start = 0; start < listings.length; start += AMENITY_BATCH_SIZE) {
      const batch = listings.slice(start, start + AMENITY_BATCH_SIZE);
      const accepted = scheduleAmenityBatch(
        batch,
        config,
        (merged, original) => persistAiMerged(merged, original, config, { type: 'ai-backfill' }),
      );
      if (!accepted) continue;
      queuedBatches += 1;
      for (const listing of batch) cooldown.set(`${listing.source}:${listing.id}`, now + COOLDOWN_MS);
    }
  }
  return queuedBatches;
}
