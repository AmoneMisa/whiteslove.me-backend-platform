import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('OLX availability selection and verification share one TTL policy', async () => {
  const [policy, verifier, sweep] = await Promise.all([
    readFile(new URL('../src/availability-policy.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/availability.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/availability-sweep.js', import.meta.url), 'utf8'),
  ]);

  assert.match(policy, /ACTIVE_AVAILABILITY_TTL_MS = 60 \* 60_000/u);
  assert.match(policy, /LISTING_AVAILABILITY_UNKNOWN_TTL_MS/u);
  assert.match(verifier, /ACTIVE_AVAILABILITY_TTL_MS/u);
  assert.match(verifier, /UNKNOWN_AVAILABILITY_TTL_MS/u);
  assert.match(sweep, /ACTIVE_AVAILABILITY_TTL_MS/u);
  assert.match(sweep, /UNKNOWN_AVAILABILITY_TTL_MS/u);
  const duplicatedTtlConfig = /process\.env\.LISTING_AVAILABILITY_(?:TTL_MS|UNKNOWN_TTL_MS)/u;
  assert.doesNotMatch(verifier, duplicatedTtlConfig);
  assert.doesNotMatch(sweep, duplicatedTtlConfig);
});
