import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {canUseFastListingPath} from '../src/support/postgres-search-fast.js';

const baseFilters = {
  listingId: '932949554',
  sources: ['olx'],
  propertyType: 'any',
  dealType: 'any',
  agency: 'any',
  audience: 'any',
  maxAgeDays: 14,
  limit: 1,
  offset: 0,
};

test('exact source listing requests qualify for the indexed detail path', () => {
  assert.equal(canUseFastListingPath(baseFilters, ['UA'], null), true);
  assert.equal(canUseFastListingPath({...baseFilters, sources: []}, ['UA'], null), false);
  assert.equal(canUseFastListingPath(baseFilters, ['UA', 'UZ'], null), false);
  assert.equal(canUseFastListingPath({...baseFilters, priceMax: 500}, ['UA'], null), false);
  assert.equal(canUseFastListingPath({...baseFilters, includeStats: true}, ['UA'], null), false);
});

test('fast searches use one database request and exact lookups follow the unique index order', async () => {
  const source = await readFile(new URL('../src/infrastructure/search/postgres-search-fast-core.js', import.meta.url), 'utf8');

  assert.match(source, /from '\.\/postgres-search-core\.js'/u);
  assert.doesNotMatch(source, /from '\.\/postgres-search\.js'/u);
  assert.match(source, /l\.source = \$1[\s\S]*l\.country = \$2[\s\S]*l\.source_id = \$3/u);
  assert.match(source, /searchPath: 'postgres-listing-id'/u);
  assert.match(source, /const cursorCount = Number\(cursor\?\.c\)/u);
  assert.match(source, /const hasCursorCount = useCursor && Number\.isSafeInteger\(cursorCount\) && cursorCount >= 0/u);
  assert.match(source, /const fetchLimit = limit \+ 1/u);
  assert.match(source, /const pageSql = hasCursorCount[\s\S]*SELECT p\.db_id, p\.created_at, l\.data[\s\S]*SELECT totals\.count/u);
  assert.match(source, /FROM \(SELECT COUNT\(\*\)::int AS count FROM deduped\) totals/u);
  assert.match(source, /const hasMore = pageRows\.length > limit/u);
  assert.match(source, /const rows = pageRows\.slice\(0, limit\)/u);
  assert.match(source, /encodeCursor\(\{v: CURSOR_VERSION, sort, t: time, id: String\(last\.db_id\), c: count\}\)/u);
  assert.doesNotMatch(source, /if \(rows\.length === limit\)/u);
  assert.doesNotMatch(source, /Promise\.all/u);
});
