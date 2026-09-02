import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASHKENT_METRO,
  TASHKENT_METRO_BY_NAME,
  canonicalTashkentMetro,
} from '../src/geo/tashkent-metro.js';

test('Tashkent metro wrapper only relies on the public parsing-lexicon contract', () => {
  assert.ok(Array.isArray(TASHKENT_METRO));
  assert.ok(TASHKENT_METRO.length > 0);
  assert.ok(TASHKENT_METRO_BY_NAME instanceof Map);

  const first = TASHKENT_METRO[0];
  assert.equal(TASHKENT_METRO_BY_NAME.get(first.name), first);
  assert.equal(canonicalTashkentMetro(first.name), first.canonical);
});
