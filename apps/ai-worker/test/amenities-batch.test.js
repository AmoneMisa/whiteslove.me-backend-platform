import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAmenityBlocks, amenitiesPayload } from '../src/prompts/amenities.js';
import {
  AMENITY_FLAG_FIELDS,
  AmenitiesSchema,
  amenitiesJsonSchema,
  sanitizeAmenities,
} from '../src/schemas/amenities.js';
import { EXTRACTION_KINDS, PUBLIC_EXTRACTION_KINDS } from '../src/services/extract.js';

test('numbered blocks are split back into listings', () => {
  const text = '[#1]\nСдаётся 2к, посудомойка\nвторая строка\n\n[#2]\nStudio with balcony\n\n[#3]\n';
  assert.deepEqual(parseAmenityBlocks(text), [
    { id: 1, text: 'Сдаётся 2к, посудомойка\nвторая строка' },
    { id: 2, text: 'Studio with balcony' },
  ]);
  assert.equal(amenitiesPayload({ text, meta: { country: 'UZ' } }).listings.length, 2);
});

test('redaction placeholders cannot break the block markers', () => {
  const text = '[#1]\ncall [PHONE] or [TELEGRAM] http [URL]\n\n[#2]\nnext';
  assert.deepEqual(parseAmenityBlocks(text).map((l) => l.id), [1, 2]);
});

test('the amenities kind is registered and exposes only amenity flags', () => {
  assert.ok(PUBLIC_EXTRACTION_KINDS.includes('amenities'));
  assert.ok(EXTRACTION_KINDS.amenities);
  const item = amenitiesJsonSchema.properties.results.items;
  assert.deepEqual(
    Object.keys(item.properties).sort(),
    ['confidence', 'id', ...AMENITY_FLAG_FIELDS].sort(),
  );
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
});

test('one malformed item does not discard the rest of the batch', () => {
  const parsed = AmenitiesSchema.parse({
    results: [
      { id: 1, dishwasher: true, tv: 'yes', confidence: 0.9 },
      { dishwasher: true },
      'garbage',
      { id: 2, oven: false, confidence: 0.8 },
      { id: 2, oven: true, confidence: 0.8 },
    ],
  });
  const { results, confidence } = sanitizeAmenities(parsed);
  assert.deepEqual(results.map((item) => item.id), [1, 2]);
  assert.equal(results[0].dishwasher, true);
  assert.equal(results[0].tv, null);
  assert.equal(results[1].oven, false);
  assert.ok(Math.abs(confidence - 0.85) < 1e-9);
});

test('a non-array answer degrades to an empty batch', () => {
  assert.deepEqual(sanitizeAmenities(AmenitiesSchema.parse({ results: 'nope' })).results, []);
});
