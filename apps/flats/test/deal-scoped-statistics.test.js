import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/infrastructure/search/postgres-search-core.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/routes/listing-routes.js', import.meta.url), 'utf8');

test('listing geography statistics are split by sale, rent, short rent and room rent', () => {
  assert.match(source, /AS deal_key/u);
  assert.match(source, /GROUP BY GROUPING SETS/u);
  assert.match(source, /\(v\.deal_key, geo\.dimension, geo\.label\)/u);
  assert.match(source, /AS geographies_by_deal/u);
  assert.match(source, /geographiesByDeal: countOrStatsResult\.rows\[0\]\?\.geographies_by_deal/u);
  assert.match(source, /WHEN data @> '\{"roomOnly":true\}'::jsonb THEN 'roomRent'/u);
});

test('filtered listing statistics expose min and max USD prices for deals and geography', () => {
  assert.match(source, /ROUND\(MIN\(price_usd\)::numeric, 2\) AS min_usd/u);
  assert.match(source, /ROUND\(MAX\(price_usd\)::numeric, 2\) AS max_usd/u);
  assert.match(source, /ROUND\(MIN\(v\.price_usd\)::numeric, 2\) AS min_usd/u);
  assert.match(source, /ROUND\(MAX\(v\.price_usd\)::numeric, 2\) AS max_usd/u);
  assert.match(source, /'minUsd', min_usd/u);
  assert.match(source, /'maxUsd', max_usd/u);
});

test('stats-only requests do not repeat the full ranked page query', () => {
  assert.match(routes, /statsOnly: bool\(q\.statsOnly\) === true/u);
  assert.match(source, /if \(filters\.includeStats && filters\.statsOnly\)/u);
  assert.match(source, /countOrStatsResult = await pool\.query\(statsSql, baseParams\)/u);
  assert.match(source, /let pageResult = \{rows: \[\]\}/u);
  assert.match(source, /const hasMore = !filters\.statsOnly && pageResult\.rows\.length > limit/u);
  assert.match(source, /const rows = filters\.statsOnly \? \[\] : pageResult\.rows\.slice\(0, limit\)/u);
});
