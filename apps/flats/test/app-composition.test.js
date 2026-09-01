import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createApp} from '../src/app.js';

const serverSource = readFileSync(
  new URL('../src/server.js', import.meta.url),
  'utf8',
);

test('createApp composes public and internal routes without opening a port', () => {
  const app = createApp();
  assert.equal(typeof app, 'function');
  assert.equal(typeof app.listen, 'function');
  assert.equal(app.get('trust proxy'), 1);

  const paths = (app.router?.stack ?? [])
    .map((layer) => layer.route?.path)
    .filter(Boolean);

  assert.ok(paths.includes('/api/listings'));
  assert.ok(paths.includes('/api/countries'));
  assert.ok(paths.includes('/api/rates'));
  assert.ok(paths.includes('/health'));
  assert.ok(paths.includes('/internal/refresh'));
});

test('server.js owns lifecycle only, not route definitions', () => {
  assert.match(serverSource, /createApp\(\)/);
  assert.match(serverSource, /app\.listen\(/);
  assert.doesNotMatch(serverSource, /app\.(get|post|put|patch|delete)\(/);
  assert.doesNotMatch(serverSource, /express\.application\.listen/);
});
