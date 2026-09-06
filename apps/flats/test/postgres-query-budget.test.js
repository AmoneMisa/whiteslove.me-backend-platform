import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('map feed uses one narrow PostgreSQL query instead of listing-page fanout', async () => {
  const source = await readFile(new URL('../src/routes/map-feed.js', import.meta.url), 'utf8');

  assert.match(source, /buildSearchContext/u);
  assert.match(source, /const \{ rows \} = await pool\.query\(sql, params\)/u);
  assert.match(source, /SELECT DISTINCT ON \(dedupe_key\)/u);
  assert.match(source, /COUNT\(\*\)::int AS total_count/u);
  assert.match(source, /COUNT\(\*\) FILTER/u);
  assert.doesNotMatch(source, /\bLIMIT\b|MAP_MAX_POINTS|MAP_FEED_MAX_POINTS/u);
  // The marker photo is a jsonb walk over the payload. It belongs after
  // deduplication and coordinate filtering, rather than in the filtered set.
  assert.match(source, /LEFT JOIN listings AS payload ON payload\.id = points\.db_id/u);
  assert.match(source, /NULLIF\(BTRIM\(payload\.data->>'photo'\), ''\)/u);
  assert.doesNotMatch(source, /l\.data->>'photo'/u);
  assert.doesNotMatch(source, /searchPostgresListings/u);
  assert.doesNotMatch(source, /attachMarketComparisons/u);
  assert.doesNotMatch(source, /do \{/u);
  assert.doesNotMatch(source, /MAP_PAGE_SIZE/u);
});

test('cursor pages carry total and use limit plus one instead of repeated exact counts', async () => {
  const source = await readFile(new URL('../src/infrastructure/search/postgres-search-core.js', import.meta.url), 'utf8');
  const wrapper = await readFile(new URL('../src/support/postgres-search.js', import.meta.url), 'utf8');

  assert.match(source, /const cursorCount = Number\(cursor\?\.c\)/u);
  assert.match(source, /else if \(hasCursorCount\) \{[\s\S]*pageResult = await pool\.query\(pageSql, pageParams\)[\s\S]*count: cursorCount/u);
  assert.match(source, /const fetchLimit = filters\.statsOnly \? limit : limit \+ 1/u);
  assert.match(source, /const hasMore = !filters\.statsOnly && pageResult\.rows\.length > limit/u);
  assert.match(source, /pageResult\.rows\.slice\(0, limit\)/u);
  assert.match(source, /if \(hasMore && \['newest', 'oldest'\]\.includes\(context\.sort\)\)/u);
  assert.match(source, /encodeCursor\(\{ v: CURSOR_VERSION, sort: context\.sort, t: time, id: String\(last\.db_id\), c: count \}\)/u);
  assert.match(wrapper, /prepareCursorForScope/u);
  assert.match(wrapper, /attachScopeToCursor/u);
});

test('title ordering no longer reaches SQL or its index', async () => {
  const search = await readFile(new URL('../src/infrastructure/search/postgres-search-core.js', import.meta.url), 'utf8');
  const routes = await readFile(new URL('../src/routes/listing-routes.js', import.meta.url), 'utf8');
  const migrationSql = await readFile(new URL('../migrations/042_drop_title_sort_index.sql', import.meta.url), 'utf8');

  // Title was the only sort the public-feed read model could not serve, so it
  // fell through to the general path and sorted the whole matching set.
  assert.doesNotMatch(routes, /'titleAsc'|'titleDesc'/u);
  assert.doesNotMatch(search, /LOWER\(l\.title\)/u);
  // An unknown sort must still resolve to the default order for older clients.
  assert.match(search, /case 'newest': default:/u);
  assert.match(migrationSql, /DROP INDEX IF EXISTS listings_feed_title_idx/u);
});
