import { z } from 'zod';

// Narrow, batched sibling of the apartment schema: several listings in one
// request, and only the amenity flags the search filters read. Free-tier
// providers meter requests far more tightly than tokens, so one request that
// answers N listings with ~15 booleans each costs a fraction of N full
// extractions.

export const AMENITY_FLAG_FIELDS = Object.freeze([
  'balcony', 'airConditioner', 'gas', 'parking', 'internet',
  'dishwasher', 'terrace', 'privateYard', 'tv', 'microwave', 'oven',
  'bidet', 'walkInCloset', 'bathtub', 'shower', 'euroLayout',
]);

const BOOL = ['boolean', 'null'];

const itemProperties = {
  id: { type: 'integer' },
  ...Object.fromEntries(AMENITY_FLAG_FIELDS.map((field) => [field, { type: BOOL }])),
  confidence: { type: 'number' },
};

export const amenitiesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: itemProperties,
        required: Object.keys(itemProperties),
      },
    },
  },
  required: ['results'],
};

const nullableBool = z.boolean().nullable().catch(null);

const ItemSchema = z.object({
  // Some models echo the id back as a string ("1").
  id: z.coerce.number().int(),
  ...Object.fromEntries(AMENITY_FLAG_FIELDS.map((field) => [field, nullableBool])),
  confidence: z.number().min(0).max(1).catch(0),
});

// Models do not always wrap the answer the way the schema asks: some return the
// bare array, some name the wrapper differently, and a one-listing batch often
// comes back as a single item. All of those carry the same answer, so accept
// them rather than failing the whole batch over the envelope.
const WRAPPER_KEYS = ['listings', 'items', 'data', 'answers', 'result'];

function coerceBatch(value) {
  if (Array.isArray(value)) return { results: value };
  if (value && typeof value === 'object') {
    if (Array.isArray(value.results)) return value;
    for (const key of WRAPPER_KEYS) if (Array.isArray(value[key])) return { results: value[key] };
    if (value.id != null) return { results: [value] };
  }
  return value;
}

// One malformed item must not discard the rest of the batch.
export const AmenitiesSchema = z.preprocess(coerceBatch, z.object({
  results: z.array(z.unknown()).catch([]).transform((items) => items
    .map((item) => ItemSchema.safeParse(item))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)),
}));

export function sanitizeAmenities(value) {
  const seen = new Set();
  const results = (value.results || []).filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const confidence = results.length
    ? results.reduce((sum, item) => sum + item.confidence, 0) / results.length
    : 0;
  return { results, confidence };
}
