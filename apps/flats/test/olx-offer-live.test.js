import test from 'node:test';
import assert from 'node:assert/strict';
import {isOlxOfferLive} from '../src/scrapers/olx.js';

test('an OLX offer the API still returns but marks removed or expired is not live', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(isOlxOfferLive({id: 1, status: 'active'}, now), true);
  assert.equal(isOlxOfferLive({id: 1}, now), true);
  assert.equal(isOlxOfferLive({id: 1, status: 'limited'}, now), true);
  assert.equal(isOlxOfferLive({id: 1, status: 'removed_by_user'}, now), false);
  assert.equal(isOlxOfferLive({id: 1, status: 'outdated'}, now), false);
  assert.equal(isOlxOfferLive({id: 1, status: 'active', valid_to_time: '2026-09-01T00:00:00+05:00'}, now), false);
  assert.equal(isOlxOfferLive({id: 1, status: 'active', valid_to_time: '2026-10-29T00:00:00+05:00'}, now), true);
  assert.equal(isOlxOfferLive(null, now), false);
});
