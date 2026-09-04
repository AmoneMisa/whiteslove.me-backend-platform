import test from 'node:test';
import assert from 'node:assert/strict';

import { newestFirst, listingRecency } from '../src/listing/enrichment-priority.js';

// Free-provider capacity runs at tens of listings an hour against a backlog of
// hundreds of thousands, so the order candidates are taken in decides what
// actually gets analysed. A fresh advert is the one a searcher is about to
// open; a stale one may not even be available any more.

const at = (iso) => ({ createdAt: iso });

test('the newest advert is analysed first', () => {
  const ordered = newestFirst([
    at('2026-01-10T00:00:00Z'),
    at('2026-09-01T00:00:00Z'),
    at('2026-05-05T00:00:00Z'),
  ]);
  assert.deepEqual(ordered.map((l) => l.createdAt), [
    '2026-09-01T00:00:00Z',
    '2026-05-05T00:00:00Z',
    '2026-01-10T00:00:00Z',
  ]);
});

test('the caller\'s array is left alone', () => {
  const input = [at('2026-01-01T00:00:00Z'), at('2026-08-01T00:00:00Z')];
  const before = input.map((l) => l.createdAt);
  newestFirst(input);
  assert.deepEqual(input.map((l) => l.createdAt), before);
});

test('firstSeenAt stands in when the advert states no publication date', () => {
  const withCreated = { createdAt: '2026-03-01T00:00:00Z' };
  const withFirstSeen = { firstSeenAt: '2026-07-01T00:00:00Z' };
  assert.deepEqual(newestFirst([withCreated, withFirstSeen]), [withFirstSeen, withCreated]);
});

test('createdAt wins over the crawl dates when both are present', () => {
  // We care when the advert was published, not when we happened to see it.
  const listing = {
    createdAt: '2026-02-01T00:00:00Z',
    firstSeenAt: '2026-08-01T00:00:00Z',
    lastSeenAt: '2026-09-01T00:00:00Z',
  };
  assert.equal(listingRecency(listing), Date.parse('2026-02-01T00:00:00Z'));
});

test('a listing with no usable date sorts last instead of jumping the queue', () => {
  const dated = at('2020-01-01T00:00:00Z');
  const undated = { source: 'olx' };
  const nonsense = { createdAt: 'not a date' };
  const ordered = newestFirst([undated, nonsense, dated]);
  assert.equal(ordered[0], dated);
});

test('a Date object is handled as well as an ISO string', () => {
  const older = at('2026-01-01T00:00:00Z');
  const newer = { createdAt: new Date('2026-06-01T00:00:00Z') };
  assert.deepEqual(newestFirst([older, newer]), [newer, older]);
});

test('a non-array is not a crash', () => {
  assert.deepEqual(newestFirst(undefined), []);
  assert.deepEqual(newestFirst(null), []);
});
