import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const source = await readFile(new URL('../src/infrastructure/search/postgres-search-core.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/routes/listing-routes.js', import.meta.url), 'utf8');

test('listing geography statistics are split by sale, rent, short rent and room rent', () => {
  assert.match(source, /AS deal_key/u);
  assert.match(source, /GROUP BY GROUPING SETS/u);
  assert.match(source, /\(v\.deal_key, geo\.dimension, geo\.label\)/u);
  assert.match(source, /AS geographies_by_deal/u);
  assert.match(source, /geographiesByDeal: countOrStatsResult\.rows\[0\]\?\.geographies_by_deal/u);
  assert.match(source, /WHEN room_only THEN 'roomRent'/u);
});

test('filtered listing statistics expose min and max USD prices for deals and geography', () => {
  assert.match(source, /ROUND\(MIN\(price_usd\)::numeric, 2\) AS min_usd/u);
  assert.match(source, /ROUND\(MAX\(price_usd\)::numeric, 2\) AS max_usd/u);
  assert.match(source, /ROUND\(MIN\(v\.price_usd\)::numeric, 2\) AS min_usd/u);
  assert.match(source, /ROUND\(MAX\(v\.price_usd\)::numeric, 2\) AS max_usd/u);
  assert.match(source, /'minUsd', min_usd/u);
  assert.match(source, /'maxUsd', max_usd/u);
});

test('statistics ignore implausible prices and expose a price distribution per deal', async () => {
  const { plausiblePriceUsdSql, PLAUSIBLE_PRICE_USD } = await import('../src/support/price-plausibility.js');
  const snapshot = await readFile(new URL('../src/support/statistics-snapshot.js', import.meta.url), 'utf8');
  const sql = plausiblePriceUsdSql('x.p', 'x.deal_type', 'x.room_only');
  assert.match(sql, /WHEN 'longRent' THEN \(p\.value >= 60 AND p\.value <= 30000\)/u);
  assert.match(sql, /WHEN 'shortRent' THEN \(p\.value >= 8 AND p\.value <= 1500\)/u);
  assert.ok(PLAUSIBLE_PRICE_USD.longRent[1] < 11_000_000);
  assert.ok(PLAUSIBLE_PRICE_USD.longRent[0] > 0);
  for (const file of [source, snapshot]) {
    assert.match(file, /plausiblePriceUsdSql\(/u);
    assert.match(file, /AS price_distribution_by_deal/u);
    assert.match(file, /priceDistributionByDeal:/u);
    assert.match(file, /WIDTH_BUCKET\(c\.price_usd/u);
    assert.match(file, /dimension IN \('district', 'microdistrict', 'metro'\) THEN 60/u);
  }
});

test('stats-only requests do not repeat the full ranked page query', () => {
  assert.match(routes, /statsOnly: bool\(q\.statsOnly\) === true/u);
  assert.match(source, /if \(filters\.includeStats && filters\.statsOnly\)/u);
  assert.match(source, /countOrStatsResult = await pool\.query\(statsSql, baseParams\)/u);
  assert.match(source, /let pageResult = \{rows: \[\]\}/u);
  assert.match(source, /const hasMore = !filters\.statsOnly && pageResult\.rows\.length > limit/u);
  assert.match(source, /const rows = filters\.statsOnly \? \[\] : pageResult\.rows\.slice\(0, limit\)/u);
});

test('price-range requests return plausible bounds without the price filter or a page query', () => {
  const fastCore = readFileSync(new URL('../src/infrastructure/search/postgres-search-fast-core.js', import.meta.url), 'utf8');
  assert.match(routes, /priceRangeOnly: bool\(q\.priceRangeOnly\) === true/u);
  assert.match(routes, /if \(filters\.priceRangeOnly\)[\s\S]*priceMin: null,\s*priceMax: null,\s*priceTolerance: null/u);
  assert.match(routes, /priceRange: result\.priceRange/u);
  assert.match(source, /if \(filters\.priceRangeOnly\)[\s\S]*plausiblePriceUsdSql\(context\.priceUsdExpr/u);
  assert.match(source, /MIN\(price_usd\) AS min_usd,\s*MAX\(price_usd\) AS max_usd/u);
  assert.match(fastCore, /filters\.mapOnly \|\| filters\.priceRangeOnly\) return false/u);
});
