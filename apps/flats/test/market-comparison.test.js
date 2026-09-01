import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const comparison = await readFile(new URL('../src/market-comparison.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/listing-routes.js', import.meta.url), 'utf8');
const marketIndexes = await readFile(new URL('../migrations/009_market_comparison_indexes.sql', import.meta.url), 'utf8');
const optimizedMarketIndexes = await readFile(new URL('../migrations/015_market_comparison_expression_indexes.sql', import.meta.url), 'utf8');
const persistedDedupe = await readFile(new URL('../migrations/010_persisted_dedupe_key.sql', import.meta.url), 'utf8');

test('good-price assessment is calculated from the active PostgreSQL market, not the loaded page', () => {
  assert.match(routes, /attachMarketComparisons\(listings, fxRates\)/u);
  assert.match(comparison, /JOIN listings c/u);
  assert.match(comparison, /c\.active = TRUE/u);
  assert.match(comparison, /PERCENTILE_CONT\(0\.5\) WITHIN GROUP \(ORDER BY price_usd\)/u);
  assert.match(comparison, /stats\.comparableCount >= MIN_COMPARABLES/u);
  assert.match(comparison, /priceRatio < 1/u);
});

test('market comparison matches city, district, deal and property type with indexed room and area branches', () => {
  assert.match(comparison, /UPPER\(c\.country\) = t\.country/u);
  assert.match(comparison, /LOWER\(BTRIM\(COALESCE\(c\.city, ''\)\)\) = LOWER\(BTRIM\(t\.city\)\)/u);
  assert.doesNotMatch(comparison, /AND c\.city = t\.city/u);
  assert.match(comparison, /t\.district IS NULL OR LOWER\(BTRIM\(COALESCE\(c\.district, ''\)\)\) = LOWER\(BTRIM\(t\.district\)\)/u);
  assert.match(comparison, /c\.property_type = t\.property_type/u);
  assert.match(comparison, /roomOnly/u);

  assert.match(comparison, /room_candidates AS/u);
  assert.match(comparison, /ON t\.rooms IS NOT NULL/u);
  assert.match(comparison, /AND c\.rooms = t\.rooms/u);

  assert.match(comparison, /area_candidates AS/u);
  assert.match(comparison, /ON t\.rooms IS NULL/u);
  assert.match(comparison, /c\.area_sqm BETWEEN/u);
  assert.match(comparison, /GREATEST\(5\.0, t\.area_sqm \* 0\.15\)/u);
  assert.match(comparison, /UNION ALL/u);
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
