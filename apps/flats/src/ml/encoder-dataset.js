// Builds training rows for the apartment encoder from stored listings.
//
// The encoder replaces the external LLM call in ai-enrichment, so its targets
// are the same fields the model fills (SCALAR_FIELDS there). Labels come from
// what the pipeline already stored: the value, plus field provenance saying
// which tier produced it. Provenance becomes a label weight -- a value from the
// source's own metadata is near-certain, a value an earlier model guessed is not.

import { FIELD_SOURCES } from '../listing/field-provenance.js';
import { hasNegatedMention } from './field-evidence.js';

/** Boolean flags: classes are yes / no / unsaid. */
export const BOOL_TARGETS = Object.freeze([
  'newBuilding', 'balcony', 'airConditioner', 'gas', 'dishwasher', 'terrace',
  'privateYard', 'tv', 'microwave', 'oven', 'bidet', 'walkInCloset', 'bathtub',
  'shower', 'euroLayout', 'furnished', 'petsAllowed', 'childrenAllowed',
  'communalSeparated', 'parking', 'elevator', 'heating', 'hotWater', 'internet',
  'smokingAllowed',
]);

/** Enumerations: classes are the listed values plus unsaid. */
export const ENUM_TARGETS = Object.freeze({
  condition: ['needs_renovation', 'basic', 'good', 'modern', 'luxury'],
});

/** Higher is more trustworthy; 0 means the label is unusable. */
export const SOURCE_WEIGHT = Object.freeze({
  [FIELD_SOURCES.structured]: 1,
  [FIELD_SOURCES.adapter]: 1,
  [FIELD_SOURCES.labelled]: 0.9,
  [FIELD_SOURCES.description]: 0.6,
  [FIELD_SOURCES.ai]: 0.3,
});

const BOOL_CLASSES = ['unsaid', 'no', 'yes'];

function boolClass(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'unsaid';
}

/**
 * One training row, or null when the text is unusable.
 *
 * An unset field (null/undefined with no provenance) is labelled `unsaid` with
 * full weight only when no tier claimed it: the pipeline looked and found
 * nothing. A field whose only source is a model is down-weighted, not dropped,
 * so the encoder can still learn from weak labels.
 */
export function buildEncoderRow(listing, { redact = (text) => text } = {}) {
  const text = redact(`${listing?.title || ''}\n${listing?.description || ''}`.trim());
  if (text.length < 20) return null;
  const provenance = listing.fieldProvenance ?? {};

  const labels = {};
  const weights = {};
  const put = (field, label) => {
    const source = provenance[field]?.source;
    const hasValue = label !== 'unsaid';
    let weight = hasValue ? (SOURCE_WEIGHT[source] ?? SOURCE_WEIGHT[FIELD_SOURCES.description]) : 1;
    // A stored `false` is only a label when the text denies the feature;
    // otherwise it is a default and is excluded from the loss (weight 0).
    if (label === 'no' && !hasNegatedMention(text, field)) weight = 0;
    labels[field] = label;
    weights[field] = weight;
  };

  for (const field of BOOL_TARGETS) put(field, boolClass(listing[field]));
  for (const [field, classes] of Object.entries(ENUM_TARGETS)) {
    put(field, classes.includes(listing[field]) ? listing[field] : 'unsaid');
  }

  return {
    id: `${listing.source}:${listing.sourceId ?? listing.id}`,
    lang: listing.lang ?? null,
    text,
    labels,
    weights,
  };
}

export { BOOL_CLASSES };

/** Deterministic split by id hash so reruns never leak test rows into train. */
export function splitOf(id, { valPercent = 10, testPercent = 10 } = {}) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  }
  const bucket = h % 100;
  if (bucket < testPercent) return 'test';
  if (bucket < testPercent + valPercent) return 'val';
  return 'train';
}
