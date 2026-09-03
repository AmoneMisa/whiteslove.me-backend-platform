import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASHKENT_METRO,
  TASHKENT_METRO_BY_NAME,
} from '../src/geo/tashkent-metro.js';

test('Tashkent metro wrapper derives its compatibility index from the shared catalog', () => {
  assert.ok(Array.isArray(TASHKENT_METRO));
  assert.ok(TASHKENT_METRO.length > 0);
  assert.ok(TASHKENT_METRO_BY_NAME instanceof Map);

  const first = TASHKENT_METRO[0];
  assert.equal(TASHKENT_METRO_BY_NAME.get(first.name), first);
});
