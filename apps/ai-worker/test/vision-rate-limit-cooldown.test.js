import test from 'node:test';
import assert from 'node:assert/strict';

import { retryAfterMs } from '../src/util/httpProvider.js';

// Mistral produced 2679 of the 2766 vision records this deployment has, and
// its limit is per-second. Benching it for the full five-minute cooldown on a
// 429 kept it out of the chain for nearly all of its life, so every job fell
// through to providers that are out of credit and the pipeline produced
// nothing at all.

test('Retry-After in seconds is read as milliseconds', () => {
  assert.equal(retryAfterMs('1'), 1000);
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(retryAfterMs('0.5'), 500);
});

test('Retry-After as an HTTP date becomes a delay from now', () => {
  const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
  const ms = retryAfterMs(inTwoMinutes);
  // Second-resolution header, so allow the rounding either way.
  assert.ok(ms >= 118_000 && ms <= 121_000, `got ${ms}`);
});

test('a date already past is no wait at all, never negative', () => {
  assert.equal(retryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0);
});

test('an absent or unusable Retry-After reports nothing rather than guessing', () => {
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs(''), null);
  assert.equal(retryAfterMs('soon'), null);
});

test('the rate-limit cooldown is far shorter than the failure cooldown', async () => {
  const { config } = await import('../src/config.js');
  assert.ok(
    config.visionRateLimitCooldownMs < config.visionCooldownMs,
    `rate-limit ${config.visionRateLimitCooldownMs} should be below failure ${config.visionCooldownMs}`,
  );
});
