import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const itemRoutes = readFileSync(
  new URL('../src/routes/listing-item-routes.js', import.meta.url),
  'utf8',
);

test('custom-source listing searches are rate limited without limiting normal search', () => {
  assert.match(appSource, /hasCustomSources/);
  assert.match(appSource, /customSourceSearch/);
  assert.match(appSource, /app\.use\('\/api\/listings'/);
  assert.doesNotMatch(appSource, /checkRate\(req, res, 'listingSearch'/);
});

test('custom-source validation is rate limited before queue submission', () => {
  const guardAt = itemRoutes.indexOf("checkRate(req, res, 'customSourceValidate', 3000)");
  const queueAt = itemRoutes.indexOf('validateCustomSource(url, country.code)');

  assert.ok(guardAt >= 0, 'custom source validation must have an abuse guard');
  assert.ok(queueAt > guardAt, 'rate limit must run before custom source queue work');
  assert.doesNotMatch(itemRoutes, /scrapers\/custom/);
});