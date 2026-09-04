import test from 'node:test';
import assert from 'node:assert/strict';

import { VisionSchema, sanitizeVision, VISION_FIELDS } from '../src/schemas/vision.js';
import { parseModelJson } from '../src/util/httpProvider.js';

// A model that answers most of the questions has told us most of the answers.
// Requiring all thirty-one fields discarded every one of them over the few a
// smaller model left out, which is how nvidia and cloudflare produced nothing.

test('an answer covering only some fields is accepted and the rest read unknown', () => {
  const parsed = VisionSchema.safeParse({
    balcony: { value: true, confidence: 0.9, evidence: ['railing on the facade'] },
    roomsVisible: { value: 3, confidence: 0.8, evidence: ['three separate rooms'] },
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));

  const result = sanitizeVision(parsed.data);
  assert.equal(result.balcony.value, true);
  assert.equal(result.roomsVisible.value, 3);
  // Everything unreported stays unknown rather than becoming a false negative.
  assert.equal(result.dishwasherVisible.value, null);
  assert.equal(Object.keys(result).length, VISION_FIELDS.length);
});

test('a field with the wrong shape is still rejected', () => {
  // Coercing a bare scalar would invent a confidence the model never gave, and
  // an unexplained answer must not be promoted onto a listing.
  assert.equal(VisionSchema.safeParse({ roomsVisible: 6 }).success, false);
});

test('an unknown field is still rejected', () => {
  assert.equal(
    VisionSchema.safeParse({ swimmingPoolVisible: { value: true, confidence: 1, evidence: ['pool'] } }).success,
    false,
  );
});

test('JSON introduced by a sentence of prose is still read', () => {
  // Observed from nvidia and cloudflare: "Based on the provided image, here is
  // the JSON object with the specified keys and values:\n\n{...}".
  const answer = 'Based on the provided image, here is the JSON object:\n\n'
    + '{"balcony": {"value": true, "confidence": 0.9, "evidence": ["glazed balcony"]}}';
  const parsed = VisionSchema.safeParse(parseModelJson(answer));
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(sanitizeVision(parsed.data).balcony.value, true);
});

test('a brace inside a string does not truncate the object', () => {
  const answer = 'Here you go: {"renovationLevel": {"value": "modern", "confidence": 0.9, "evidence": ["a { brace } in text"]}} thanks';
  const parsed = VisionSchema.safeParse(parseModelJson(answer));
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(sanitizeVision(parsed.data).renovationLevel.value, 'modern');
});

test('an answer with no JSON at all is still an error', () => {
  assert.throws(() => parseModelJson('The image shows a room with two beds and a wardrobe.'));
});
