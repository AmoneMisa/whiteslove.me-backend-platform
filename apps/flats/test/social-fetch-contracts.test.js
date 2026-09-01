import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const proxy = readFileSync(new URL('../src/social-routes.js', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../../social-fetcher/Dockerfile', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../social-fetcher/main.py', import.meta.url), 'utf8');

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

test('social image runs the extended main app rather than the base app module', () => {
  assert.match(dockerfile, /COPY app\.py main\.py test_app\.py/);
  assert.match(dockerfile, /main:app/);
});
