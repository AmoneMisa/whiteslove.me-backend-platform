// Semantic text enrichment for listings, via the shared ai-worker.
//
// The deterministic lexicon parser stays authoritative. This layer only fills
// fields the parser left empty, because free-text posts routinely state things
// in phrasings no regex covers. If inference is unavailable, slow or
// low-confidence, listings keep exactly what the parser produced.
//
// Geography is the one place where a plausible guess is worse than nothing, so
// an AI district/kvartal is accepted only when it canonicalizes through the
// same location dictionary the deterministic path uses. A free-text place name
// is never written to a listing.

import {
  aiFingerprint,
  aiWorkerEnabled,
  scheduleAiExtraction,
} from '../support/ai-worker.js';
import {
  canonicalDictionaryDistrict,
  dictionaryLocationLists,
} from '../geo/location-dictionary-resolver.js';

// Bump when prompts, schema or the merge rules change, so already-enriched
// listings are re-evaluated instead of keeping an answer from the old contract.
export const APARTMENT_PARSER_VERSION = 'apartment-semantic-v1';

const MIN_CONFIDENCE = Number(process.env.AI_WORKER_APARTMENT_MIN_CONFIDENCE) || 0.6;

// Fields the model may fill, mapped onto the listing shape. Anything absent
// here is owned by the deterministic parser and is never touched.
const SCALAR_FIELDS = Object.freeze({
  rooms: 'rooms',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
  areaM2: 'areaSqm',
  floor: 'floor',
  floorsTotal: 'totalFloors',
  newBuilding: 'newBuilding',
  balcony: 'balcony',
  airConditioner: 'airConditioner',
  gas: 'gas',
  furnished: 'furnished',
  petsAllowed: 'petsAllowed',
  childrenAllowed: 'childrenAllowed',
  communalSeparated: 'communalSeparated',
  depositRequired: 'deposit',
  depositAmount: 'depositAmount',
  commissionRequired: 'commission',
  commissionPercent: 'commissionPercent',
  negotiable: 'negotiable',
  parking: 'parking',
  elevator: 'elevator',
  heating: 'heating',
  hotWater: 'hotWater',
  internet: 'internet',
  smokingAllowed: 'smokingAllowed',
  condition: 'condition',
});

// Deterministic facts handed to the model so it corroborates rather than
// contradicts, and so a changed parse invalidates the cached answer.
const KNOWN_FACT_FIELDS = Object.freeze([
  'dealType', 'propertyType', 'rooms', 'areaSqm', 'floor', 'totalFloors',
  'price', 'currency', 'city', 'district', 'kvartal',
]);

function blank(value) {
  return value == null || value === '';
}

function listingKey(listing) {
  return `${listing?.source}:${listing?.id}`;
}

export function listingAiText(listing) {
  return `${listing?.title || ''}\n${listing?.description || ''}`.trim();
}

export function apartmentAiInput(listing) {
  const rawText = listingAiText(listing);
  const knownFacts = {};
  for (const field of KNOWN_FACT_FIELDS) {
    knownFacts[field] = blank(listing?.[field]) ? null : listing[field];
  }
  return {
    rawText,
    knownFacts,
    fingerprint: aiFingerprint('apartment', rawText, {
      parserVersion: APARTMENT_PARSER_VERSION,
      ...knownFacts,
    }),
  };
}

export function needsApartmentAi(listing) {
  if (!listing || String(listing.source || '').startsWith('mock')) return false;
  if (!listingAiText(listing)) return false;
  return Object.values(SCALAR_FIELDS).some((field) => blank(listing[field]));
}

/** A dictionary-backed district, or null. Never a free-text place name. */
function acceptedDistrict(value, listing, countryCode) {
  if (blank(value) || !countryCode) return null;
  const canonical = canonicalDictionaryDistrict(String(value), countryCode);
  if (!canonical) return null;
  // A district belonging to another city is a contradiction, not enrichment.
  const known = dictionaryLocationLists(countryCode)?.[listing?.city];
  if (known && !known.districts.includes(canonical)) return null;
  return canonical;
}

function acceptedKvartal(value, listing, countryCode) {
  if (blank(value) || !countryCode) return null;
  const known = dictionaryLocationLists(countryCode)?.[listing?.city];
  if (!known) return null;
  const wanted = String(value).trim().toLocaleLowerCase();
  return [...known.microdistricts, ...known.localAreas, ...known.mahallas]
    .find((name) => String(name).toLocaleLowerCase() === wanted) || null;
}

/**
 * Fills empty listing fields from a validated model answer. Existing values are
 * never overwritten, and every field the model actually supplied is recorded in
 * `listing.ai.derivedFields` so the API can tell parsed from inferred.
 */
export function mergeApartmentAi(listing, result, countryCode = null) {
  const data = result?.data || {};
  const merged = { ...listing };
  const derivedFields = new Set(
    Array.isArray(listing?.ai?.derivedFields) ? listing.ai.derivedFields.map(String) : [],
  );

  for (const [aiField, listingField] of Object.entries(SCALAR_FIELDS)) {
    if (!blank(merged[listingField]) || blank(data[aiField])) continue;
    merged[listingField] = data[aiField];
    derivedFields.add(listingField);
  }

  const district = blank(merged.district)
    ? acceptedDistrict(data.district, merged, countryCode)
    : null;
  if (district) {
    merged.district = district;
    derivedFields.add('district');
  }

  const kvartal = blank(merged.kvartal)
    ? acceptedKvartal(data.kvartal, merged, countryCode)
    : null;
  if (kvartal) {
    merged.kvartal = kvartal;
    derivedFields.add('kvartal');
  }

  if (Array.isArray(data.amenities) && data.amenities.length) {
    const amenities = new Set(merged.amenities || []);
    const before = amenities.size;
    for (const amenity of data.amenities) {
      const value = String(amenity || '').trim();
      if (value) amenities.add(value);
    }
    if (amenities.size > before) {
      merged.amenities = [...amenities];
      derivedFields.add('amenities');
    }
  }

  merged.ai = {
    parserVersion: APARTMENT_PARSER_VERSION,
    fingerprint: listing?.ai?.fingerprint ?? null,
    status: 'completed',
    confidence: Number(result?.confidence) || 0,
    derivedFields: [...derivedFields].sort(),
    updatedAt: new Date().toISOString(),
  };
  return merged;
}

/**
 * Queues apartment extraction for listings the parser left incomplete.
 * `persist` receives the merged listing; callers own storage.
 */
export function scheduleListingsAi(listings, country, persist) {
  if (!aiWorkerEnabled() || !Array.isArray(listings) || !listings.length) return 0;

  const countryCode = String(country?.code || '').toUpperCase() || null;
  const batchSize = Math.max(1, Number(process.env.AI_WORKER_APARTMENT_BATCH) || 8);
  let queued = 0;

  for (const listing of listings) {
    if (queued >= batchSize) break;
    if (!needsApartmentAi(listing)) continue;

    const input = apartmentAiInput(listing);
    // Same text and same deterministic facts as last time: nothing to re-ask.
    if (listing.ai?.fingerprint === input.fingerprint) continue;

    const id = listingKey(listing);
    const accepted = scheduleAiExtraction({
      id,
      kind: 'apartment',
      rawText: input.rawText,
      knownFacts: input.knownFacts,
      fingerprint: input.fingerprint,
      meta: { source: listing.source, id: listing.id, country: countryCode, city: listing.city },
      onResult: async (result) => {
        if (result?.lowConfidence || (Number(result?.confidence) || 0) < MIN_CONFIDENCE) {
          listing.ai = {
            parserVersion: APARTMENT_PARSER_VERSION,
            fingerprint: input.fingerprint,
            status: 'low_confidence',
            confidence: Number(result?.confidence) || 0,
            updatedAt: new Date().toISOString(),
          };
          return;
        }
        const merged = mergeApartmentAi(listing, result, countryCode);
        merged.ai.fingerprint = input.fingerprint;
        await persist?.(merged);
      },
      onFailed: (status) => {
        listing.ai = {
          parserVersion: APARTMENT_PARSER_VERSION,
          fingerprint: input.fingerprint,
          status: status === 'failed' ? 'failed' : 'unavailable',
          updatedAt: new Date().toISOString(),
        };
      },
    });

    if (accepted) {
      listing.ai = {
        parserVersion: APARTMENT_PARSER_VERSION,
        fingerprint: input.fingerprint,
        status: 'pending',
        updatedAt: new Date().toISOString(),
      };
      queued += 1;
    }
  }

  if (queued) console.log(`[flats:ai] queued apartment extraction=${queued}`);
  return queued;
}
