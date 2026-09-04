import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { imageLimitFor } from '../src/services/vision-providers.js';

// More photos is strictly more evidence for the extraction, so the aim is to
// send the whole set. Only a provider that refuses that many gets cut back,
// and only to its own ceiling -- lowering the global cap to satisfy the
// strictest provider used to throw photos away for every other one.

test('a provider with no stated ceiling gets the full configured set', () => {
  for (const provider of ['gemini', 'openrouter', 'mistral', 'llm7', 'huggingface']) {
    assert.equal(imageLimitFor(provider), config.maxPhotosPerListing, provider);
  }
});

test('a provider is cut to the number of images it actually accepts', () => {
  // Neither of these truncates a too-long list; both fail the whole request.
  // Groq: HTTP 400 "This model supports up to 3 images".
  assert.equal(imageLimitFor('groq'), 3);
  // NVIDIA: HTTP 400 "At most 1 image(s) may be provided in one prompt".
  assert.equal(imageLimitFor('nvidia'), 1);
});

test('a provider ceiling never raises the global limit', () => {
  // If the deployment deliberately lowers maxPhotosPerListing, a provider
  // that could take more must still respect the smaller number.
  assert.ok(imageLimitFor('groq') <= config.maxPhotosPerListing);
  assert.ok(imageLimitFor('gemini') <= config.maxPhotosPerListing);
});

test('the default configured set is enough for a full advert', () => {
  // Listings routinely carry 7-10 photos and the extraction is meant to see
  // them; the default must not quietly sit below that.
  assert.ok(
    config.maxPhotosPerListing >= 10,
    `expected >= 10 photos, got ${config.maxPhotosPerListing}`,
  );
});
