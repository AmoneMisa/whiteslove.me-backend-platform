import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeCandidates } from '../src/geo/geocode-base.js';

const UA = { code: 'UA', name: 'Ukraine', crawlCities: ['Kyiv', 'Odesa'] };

test('a street without a city is not geocoded across the whole country', () => {
  const bare = { id: 'bare-street', address: 'Свет 24/7', street: 'Свет', city: '' };
  const sources = geocodeCandidates(bare, UA).map((candidate) => candidate.source);
  assert.ok(!sources.includes('address'));
  assert.ok(!sources.includes('street'));
});

test('the same street is still geocoded once the listing has a city', () => {
  const anchored = { id: 'anchored', address: 'Нечуя-Левицького 8', street: 'Нечуя-Левицького', city: 'Vinnytsia' };
  const sources = geocodeCandidates(anchored, UA).map((candidate) => candidate.source);
  assert.ok(sources.includes('address'));
  assert.ok(sources.includes('street'));
});
