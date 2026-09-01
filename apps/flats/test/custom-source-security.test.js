import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(
  new URL('../src/scrapers/custom.js', import.meta.url),
  'utf8',
);

test('custom source fetches never auto-follow redirects', () => {
  assert.match(source, /redirect:\s*'manual'/);
  assert.doesNotMatch(source, /redirect:\s*'follow'/);
  assert.match(source, /MAX_REDIRECTS/);
});

test('every redirect destination is revalidated before the next fetch', () => {
  const locationAt = source.indexOf("res.headers.get('location')");
  const validateAt = source.indexOf('assertSafeUrl(new URL(location, current).href)', locationAt);
  const continueAt = source.indexOf('continue;', validateAt);

  assert.ok(locationAt >= 0, 'redirect Location must be read explicitly');
  assert.ok(validateAt > locationAt, 'redirect destination must pass SSRF validation');
  assert.ok(continueAt > validateAt, 'validation must happen before following the redirect');
});

test('private and local address ranges stay rejected', () => {
  assert.match(source, /a === 127/);
  assert.match(source, /a === 10/);
  assert.match(source, /a === 192 && b === 168/);
  assert.match(source, /169 && b === 254/);
  assert.match(source, /lc === '::1'/);
  assert.match(source, /lc\.startsWith\('fc'\)/);
  assert.match(source, /lc\.startsWith\('fd'\)/);
});