// Batched, amenity-only enrichment for stored listings.
//
// The search filters read sixteen amenity flags, and most stored listings have
// them unknown. Asking a model for the full apartment record to learn them
// spends one rate-limited request per listing and ~400 output tokens on fields
// the parser already has. This asks one request per batch of listings for just
// the flags, and skips listings whose text is too short to say anything.

import {
  aiFingerprint,
  aiWorkerEnabled,
  scheduleAiExtraction,
} from '../support/ai-worker.js';
import { mayAiOverwrite } from './field-provenance.js';
import { createProvenance } from '@whiteslove/parsing-lexicon/provenance';
import { listingAiText } from './ai-enrichment.js';

export const AMENITY_FLAG_FIELDS = Object.freeze([
  'balcony', 'airConditioner', 'gas', 'parking', 'internet',
  'dishwasher', 'terrace', 'privateYard', 'tv', 'microwave', 'oven',
  'bidet', 'walkInCloset', 'bathtub', 'shower', 'euroLayout',
]);

// Bump when the prompt or schema changes, so listings are asked again.
export const AMENITY_PASS_VERSION = 'amenity-batch-v1';

// Below this the title/description cannot state an amenity, so the answer
// would be all-null and the request wasted.
export const MIN_AMENITY_TEXT_CHARS = Number(process.env.AI_AMENITY_MIN_TEXT_CHARS) || 60;
const MAX_ITEM_CHARS = Number(process.env.AI_AMENITY_MAX_ITEM_CHARS) || 1_500;
export const AMENITY_BATCH_SIZE = Math.max(1, Math.min(
  20,
  Number(process.env.AI_AMENITY_BATCH_SIZE) || 8,
));
const MIN_CONFIDENCE = Number(process.env.AI_WORKER_APARTMENT_MIN_CONFIDENCE) || 0.6;

const blank = (value) => value == null || value === '';

export function hasUnknownAmenity(listing) {
  return AMENITY_FLAG_FIELDS.some((field) => blank(listing?.[field]));
}

/** Whether a listing is worth putting in an amenity batch at all. */
export function needsAmenityPass(listing) {
  if (!listing || String(listing.source || '').startsWith('mock')) return false;
  if (listing.ai?.amenityPass === AMENITY_PASS_VERSION) return false;
  if (listingAiText(listing).length < MIN_AMENITY_TEXT_CHARS) return false;
  return hasUnknownAmenity(listing);
}

function listingKey(listing) {
  return `${listing?.source}:${listing?.id}`;
}

/** The "[#N]" block text the ai-worker's amenities kind expects. */
export function buildAmenityBatchText(listings) {
  return listings
    .map((listing, index) => `[#${index + 1}]\n${listingAiText(listing).slice(0, MAX_ITEM_CHARS)}`)
    .join('\n\n');
}

/**
 * Fills the amenity flags the parser left unknown from one batch item. Existing
 * values are never touched, and every flag the model supplied is recorded in
 * `ai.derivedFields` with provenance, exactly as the full enrichment does.
 *
 * A confident-enough answer is not required to mark the pass done: a low
 * confidence item fills nothing but is still not asked again, otherwise the
 * sweep would keep re-submitting the same unreadable listing.
 */
export function mergeAmenityItem(listing, item) {
  const merged = { ...listing };
  const derived = new Set(Array.isArray(listing?.ai?.derivedFields) ? listing.ai.derivedFields : []);
  const fieldProvenance = { ...(listing?.fieldProvenance ?? {}) };
  const observedAt = new Date().toISOString();
  const confident = (Number(item?.confidence) || 0) >= MIN_CONFIDENCE;

  if (confident) {
    for (const field of AMENITY_FLAG_FIELDS) {
      const value = item[field];
      if (!blank(merged[field]) || value == null) continue;
      if (!mayAiOverwrite(fieldProvenance[field])) continue;
      merged[field] = value;
      derived.add(field);
      fieldProvenance[field] = createProvenance({ source: 'ai_enrichment', parser: 'ai.amenities', observedAt });
    }
  }

  merged.ai = {
    ...(listing?.ai ?? {}),
    amenityPass: AMENITY_PASS_VERSION,
    derivedFields: [...derived].sort(),
    updatedAt: observedAt,
  };
  merged.fieldProvenance = Object.freeze(fieldProvenance);
  return merged;
}

/**
 * Queues one amenities request for up to AMENITY_BATCH_SIZE listings. Returns
 * false when nothing was queued (worker disabled, queue full, in flight).
 * `persist(merged, original)` is called once per answered listing.
 */
export function scheduleAmenityBatch(listings, country, persist) {
  if (!aiWorkerEnabled() || !Array.isArray(listings) || !listings.length) return false;
  const batch = listings.slice(0, AMENITY_BATCH_SIZE);
  const rawText = buildAmenityBatchText(batch);
  const originals = batch.map((listing) => Object.defineProperty(
    structuredClone(listing),
    '_sourceRevision',
    { value: listing._sourceRevision },
  ));

  return scheduleAiExtraction({
    id: `amenities:${listingKey(batch[0])}+${batch.length}`,
    kind: 'amenities',
    rawText,
    knownFacts: { version: AMENITY_PASS_VERSION },
    fingerprint: aiFingerprint('amenities', rawText, { version: AMENITY_PASS_VERSION }),
    meta: { country: String(country?.code || '').toUpperCase() || null, count: batch.length },
    onResult: async (result) => {
      const byId = new Map((result?.data?.results || []).map((item) => [item.id, item]));
      for (const [index, listing] of batch.entries()) {
        // A listing the model skipped is left unmarked and retried later.
        const item = byId.get(index + 1);
        if (!item) continue;
        await persist?.(mergeAmenityItem(listing, item), originals[index]);
      }
    },
  });
}
