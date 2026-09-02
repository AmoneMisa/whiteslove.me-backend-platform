import test from 'node:test';
import assert from 'node:assert/strict';

import {createMemoryCache} from '../src/support/cache.js';

test('runtime cache expires entries by TTL', () => {
  let timestamp = 1_000;
  const cache = createMemoryCache({now: () => timestamp, maxEntries: 10});

  cache.set('a', {value: 1}, 500);
  assert.deepEqual(cache.get('a'), {value: 1});

  timestamp += 500;
  assert.equal(cache.get('a'), null);
});

test('runtime cache stays bounded and evicts least recently used entries', () => {
  const cache = createMemoryCache({now: () => 2_000, maxEntries: 2});

  cache.set('a', {value: 'a'}, 60_000);
  cache.set('b', {value: 'b'}, 60_000);

  // Touch a so b becomes the least recently used entry.
  assert.deepEqual(cache.get('a'), {value: 'a'});

  cache.set('c', {value: 'c'}, 60_000);

  assert.equal(cache.get('b'), null);
  assert.deepEqual(cache.get('a'), {value: 'a'});
  assert.deepEqual(cache.get('c'), {value: 'c'});
});

test('runtime cache removes expired entries before evicting active ones', () => {
  let timestamp = 3_000;
  const cache = createMemoryCache({now: () => timestamp, maxEntries: 2});

  cache.set('expired', {value: 1}, 10);
  cache.set('active', {value: 2}, 60_000);

  timestamp += 20;
  cache.set('new', {value: 3}, 60_000);

  assert.equal(cache.get('expired'), null);
  assert.deepEqual(cache.get('active'), {value: 2});
  assert.deepEqual(cache.get('new'), {value: 3});
});
