import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const comparison = await readFile(new URL('../src/geo/market-comparison.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/routes/listing-routes.js', import.meta.url), 'utf8');
const marketIndexes = await readFile(new URL('../migrations/009_market_comparison_indexes.sql', import.meta.url), 'utf8');
const optimizedMarketIndexes = await readFile(new URL('../migrations/015_market_comparison_expression_indexes.sql', import.meta.url), 'utf8');
const persistedDedupe = await readFile(new URL('../migrations/010_persisted_dedupe_key.sql', import.meta.url), 'utf8');

test('good-price assessment is calculated from the active PostgreSQL market, not the loaded page', () => {
  assert.match(routes, /attachMarketComparisons\(listings, fxRates\)/u);
  assert.match(comparison, /FROM listings c/u);
  assert.match(comparison, /c\.active = TRUE/u);
  assert.match(comparison, /PERCENTILE_CONT\(0\.5\) WITHIN GROUP \(ORDER BY price_usd\)/u);
  assert.match(comparison, /stats\.comparableCount >= MIN_COMPARABLES/u);
  assert.match(comparison, /priceRatio < 1/u);
});

test('market comparison matches city, district, deal and property type with indexed room and area branches', () => {
  // Segment values are bound per target so the planner sees real values and
  // can seek the rooms/area expression indexes on every constrained column.
  assert.match(comparison, /UPPER\(c\.country\) = \$\{bind\(target\.country\)\}/u);
  assert.match(comparison, /LOWER\(BTRIM\(COALESCE\(c\.city, ''\)\)\) = LOWER\(BTRIM\(\$\{bind\(target\.city\)\}::text\)\)/u);
  assert.doesNotMatch(comparison, /AND c\.city = t\.city/u);
  assert.match(comparison, /c\.property_type = \$\{bind\(target\.property_type\)\}/u);
  assert.match(comparison, /roomOnly/u);
  assert.match(comparison, /c\.rooms = \$\{bind\(target\.rooms\)\}::integer/u);
  assert.match(comparison, /c\.area_sqm BETWEEN/u);
  assert.match(comparison, /GREATEST\(5\.0, \$\{area\}::double precision \* 0\.15\)/u);
  assert.match(comparison, /UNION ALL/u);

  // An OR around the district kept rooms and district out of the index
  // condition, so one target read its whole city segment. A target without a
  // district simply omits the predicate instead.
  assert.doesNotMatch(comparison, /district IS NULL OR/u);
  assert.match(comparison, /if \(target\.district\) \{/u);
  assert.match(comparison, /LOWER\(BTRIM\(COALESCE\(c\.district, ''\)\)\) = LOWER\(BTRIM\(\$\{bind\(target\.district\)\}::text\)\)/u);
});

test('extended statistics let the planner pick the index that constrains rooms or area', async () => {
  const stats = await readFile(new URL('../migrations/062_market_segment_statistics.sql', import.meta.url), 'utf8');
  assert.match(stats, /CREATE STATISTICS IF NOT EXISTS listings_market_segment_stats/u);
  assert.match(stats, /\(UPPER\(country\)\)/u);
  assert.match(stats, /\(LOWER\(BTRIM\(COALESCE\(city, ''\)\)\)\)/u);
  assert.match(stats, /\(CASE WHEN room_only THEN 'roomRent' ELSE deal_type END\)/u);
  assert.match(stats, /SET LOCAL lock_timeout/u);
});

test('a market segment is computed once and reused by later pages and popups', async () => {
  const {attachMarketComparisons, clearMarketSegmentCache} = await import('../src/geo/market-comparison.js');
  const {pool} = await import('../src/infrastructure/database/pool.js');
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push(params);
    return {rows: [{key: params[params.length - 1], comparable_count: 5, median_usd: 500}]};
  };
  try {
    clearMarketSegmentCache();
    const base = {source: 'olx', country: 'UZ', city: 'Tashkent', district: 'Chilanzar', propertyType: 'flat', dealType: 'longRent', rooms: 2, currency: 'USD'};
    const page = await attachMarketComparisons([{...base, id: '1', price: 400}, {...base, id: '2', price: 600}], {USD: 1});
    assert.equal(calls.length, 1, 'two listings in one segment share one target');
    assert.deepEqual(page.map((listing) => listing.marketComparison.goodPrice), [true, false]);

    const [popup] = await attachMarketComparisons([{...base, id: '3', price: 450}], {USD: 1});
    assert.equal(calls.length, 1, 'the popup reuses the segment the feed computed');
    assert.equal(popup.marketComparison.medianUsd, 500);
    assert.equal(popup.marketComparison.priceUsd, 450);
  } finally {
    pool.query = original;
    clearMarketSegmentCache();
  }
});

test('market median reuses persisted source-level duplicate suppression and has matching lookup indexes', () => {
  assert.match(comparison, /SELECT DISTINCT ON \(key, dedupe_key\)/u);
  assert.match(comparison, /c\.dedupe_key/u);
  assert.doesNotMatch(comparison, /MD5\(/u);
  assert.match(persistedDedupe, /telegram:photos/u);
  assert.match(persistedDedupe, /olx:photos/u);
  assert.match(marketIndexes, /listings_market_rooms_idx/u);
  assert.match(marketIndexes, /listings_market_area_idx/u);

  assert.match(optimizedMarketIndexes, /listings_market_rooms_expr_idx/u);
  assert.match(optimizedMarketIndexes, /listings_market_area_expr_idx/u);
  assert.match(optimizedMarketIndexes, /UPPER\(country\)/u);
  assert.match(optimizedMarketIndexes, /LOWER\(BTRIM\(COALESCE\(city, ''\)\)\)/u);
  assert.match(optimizedMarketIndexes, /COALESCE\(created_at, first_seen_at\)/u);
  assert.match(optimizedMarketIndexes, /roomOnly/u);
});
