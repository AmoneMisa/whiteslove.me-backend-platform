import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/geo/countries.js';
import { geocodeCandidates } from '../src/geo/geocode.js';

test('uses the listing city in geocoding candidates', () => {
  const candidates = geocodeCandidates({ id: 'canonical', city: 'Tashkent' }, COUNTRIES.UZ);
  const city = candidates.find((candidate) => candidate.source === 'city');

  assert.ok(city);
  assert.equal(city.q, 'Tashkent, Uzbekistan');
});
