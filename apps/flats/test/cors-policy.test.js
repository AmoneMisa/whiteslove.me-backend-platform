import test from 'node:test';
import assert from 'node:assert/strict';
import {createCorsOptions, parseAllowedOrigins} from '../src/support/cors-policy.js';

const decide = (options, origin) =>
  new Promise((resolve) => options.origin(origin, (_e, ok) => resolve(ok)));

test('defaults allow only whiteslove.me origins', async () => {
  const options = createCorsOptions(parseAllowedOrigins(''));
  assert.equal(await decide(options, 'https://whiteslove.me'), true);
  assert.equal(await decide(options, 'https://evil.example'), false);
});

test('requests without Origin (BFF, mobile) are allowed', async () => {
  assert.equal(await decide(createCorsOptions(parseAllowedOrigins('')), undefined), true);
});

test('CORS_ALLOWED_ORIGINS overrides defaults and trims trailing slashes', async () => {
  const options = createCorsOptions(parseAllowedOrigins('http://localhost:3000/, https://x.test'));
  assert.equal(await decide(options, 'http://localhost:3000'), true);
  assert.equal(await decide(options, 'https://whiteslove.me'), false);
});
