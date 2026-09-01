import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const proxy = readFileSync(new URL('../src/social-routes.js', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../../../services/social-fetcher/Dockerfile', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../../services/social-fetcher/main.py', import.meta.url), 'utf8');

test('social proxy routes Threads keyword search to the production search endpoint', () => {
  assert.match(proxy, /source === 'threads' && mode === 'search'/);
  assert.match(proxy, /\? '\/threads\/search'/);
  assert.match(main, /@app\.post\("\/threads\/search"\)/);
});

test('social proxy routes LinkedIn candidate discovery to its public discovery endpoint', () => {
  assert.match(proxy, /source === 'linkedin' && mode === 'candidates'/);
  assert.match(proxy, /\? '\/linkedin\/candidates'/);
  assert.match(main, /@app\.post\("\/linkedin\/candidates"\)/);
});

test('date-bounded social crawl is exposed through the authenticated proxy', () => {
  assert.match(proxy, /app\.post\('\/internal\/social\/crawl'/);
  assert.match(proxy, /proxySocial\(req, res, '\/crawl'\)/);
  assert.match(proxy, /if \(req\.body\?\.cutoff\)/);
  assert.match(main, /@app\.post\("\/crawl"\)/);
  assert.match(main, /def _scroll_until_cutoff\(/);
  assert.match(main, /def _boundary_reached\(/);

  const crawlStart = main.indexOf('def _scroll_until_cutoff(');
  const crawlEnd = main.indexOf('def _linkedin_candidate_query(');
  assert.ok(crawlStart >= 0 && crawlEnd > crawlStart);
  const crawlSection = main.slice(crawlStart, crawlEnd);
  assert.match(crawlSection, /while True:/);
  assert.match(crawlSection, /_boundary_reached\(values, cutoff\)/);
  assert.doesNotMatch(crawlSection, /THREADS_SCROLLS/);
  assert.doesNotMatch(crawlSection, /FACEBOOK_SCROLLS/);
  assert.doesNotMatch(crawlSection, /MAX_ITEMS/);
  assert.doesNotMatch(crawlSection, /\[:limit\]/);
  assert.doesNotMatch(crawlSection, /range\([^\n]*SCROLLS/);
});

test('social image runs the extended main app rather than the base app module', () => {
  assert.match(dockerfile, /COPY app\.py main\.py test_app\.py/);
  assert.match(dockerfile, /main:app/);
});
