import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeVision } from '../src/vision-enrichment.js';

function item(value, confidence = 0.9) {
  return { value, confidence, evidence: ['photo_1'] };
}

test('vision provenance marks only fields that vision actually fills', () => {
  const listing = {
    source: 'telegram',
    id: '1',
    airConditioner: null,
    balcony: true,
    bedrooms: null,
    amenities: ['tv'],
  };

  const merged = mergeVision(listing, {
    provider: 'groq',
    analyzedAt: '2026-08-24T10:00:00.000Z',
    data: {
      airConditioner: item(true),
      balcony: item(true),
      bedroomsVisible: item(2),
      washingMachineVisible: item(true),
      tvVisible: item(true),
    },
  });

  assert.equal(merged.airConditioner, true);
  assert.equal(merged.balcony, true);
  assert.equal(merged.bedrooms, 2);
  assert.equal(merged.tv, true);
  assert.deepEqual(new Set(merged.amenities), new Set(['tv', 'washing_machine']));
  assert.deepEqual(merged.vision.derivedFields, ['airConditioner', 'bedrooms', 'tv', 'washingMachine']);
});

test('low-confidence and merely agreeing vision values are not marked as derived', () => {
  const merged = mergeVision({
    source: 'olx',
    id: '2',
    furnished: true,
    parking: null,
    amenities: [],
  }, {
    provider: 'groq',
    data: {
      furnished: item(true),
      parkingVisible: item(true, 0.6),
      dishwasherVisible: item(true, 0.6),
    },
  });

  assert.equal(merged.furnished, true);
  assert.equal(merged.parking, null);
  assert.deepEqual(merged.amenities, []);
  assert.deepEqual(merged.vision.derivedFields, []);
});
