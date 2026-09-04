import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeVision } from '../src/listing/vision-enrichment.js';

// A count of zero from photos means the photos did not establish one, not that
// there are none. The vision schema already refuses to read a weak `false` as
// proof of absence; zero counts slipped past that rule and reached listings as
// fact -- a real record arrived with bathroomsVisible=0 at confidence 0.9.

const seen = (value, confidence = 0.9) => ({ value, confidence, evidence: ['photo_1'] });
const visionOf = (data) => ({ data });

test('a dwelling gets at least one bathroom when the photos show none', () => {
  const merged = mergeVision({ source: 'olx', id: '1' }, visionOf({ bathroomsVisible: seen(0) }));
  assert.equal(merged.bathrooms, 1);
});

test('the assumed bathroom does not claim photo evidence', () => {
  // The floor is a fact about dwellings, not something the photos showed, so
  // it must not inherit evidence pointing at a photo of something else.
  const merged = mergeVision({ source: 'olx', id: '1' }, visionOf({ bathroomsVisible: seen(0) }));
  assert.equal(merged.bathrooms, 1);
  assert.ok(Array.isArray(merged.vision?.derivedFields));
  assert.ok(merged.vision.derivedFields.includes('bathrooms'));
});

test('a commercial unit is not given a bathroom it may not have', () => {
  // A garage or warehouse genuinely may have none.
  const merged = mergeVision(
    { source: 'olx', id: '1', commercial: true },
    visionOf({ bathroomsVisible: seen(0) }),
  );
  assert.equal(merged.bathrooms ?? null, null);
});

test('a real bathroom count is still taken at face value', () => {
  const merged = mergeVision({ source: 'olx', id: '1' }, visionOf({ bathroomsVisible: seen(2) }));
  assert.equal(merged.bathrooms, 2);
});

test('zero rooms is not written as a fact', () => {
  // There is no sensible floor here: an exterior-only photo set establishes
  // nothing about the number of rooms.
  const merged = mergeVision(
    { source: 'olx', id: '1' },
    visionOf({ roomsVisible: seen(0), bedroomsVisible: seen(0) }),
  );
  assert.equal(merged.rooms ?? null, null);
  assert.equal(merged.bedrooms ?? null, null);
});

test('a value the parser already established is never overwritten', () => {
  const merged = mergeVision(
    { source: 'olx', id: '1', bathrooms: 3 },
    visionOf({ bathroomsVisible: seen(0) }),
  );
  assert.equal(merged.bathrooms, 3);
});

test('a low-confidence zero does not sneak the floor in', () => {
  // Below the acceptance threshold the reading is not trusted at all, so it
  // cannot be used as grounds for assuming anything.
  const merged = mergeVision(
    { source: 'olx', id: '1' },
    visionOf({ bathroomsVisible: seen(0, 0.2) }),
  );
  assert.equal(merged.bathrooms ?? null, null);
});
