import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
const platformEnv = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
const cache = readFileSync(new URL('../src/cache.js', import.meta.url), 'utf8');

test('retired scheduler toggles stay out of runtime config', () => {
  assert.doesNotMatch(compose, /DISABLE_SCHEDULER/);
  assert.doesNotMatch(platformEnv, /^REFRESH_MINUTES=/m);
  assert.doesNotMatch(platformEnv, /DISABLE_SCHEDULER/);
});

test('retired Redis and RabbitMQ infrastructure stays absent', () => {
  assert.doesNotMatch(compose, /flat-finder-redis:|flats-redis:/);
  assert.doesNotMatch(compose, /flat-finder-rabbitmq:|flats-rabbitmq:/);
  assert.doesNotMatch(compose, /REDIS_URL=/);
  assert.doesNotMatch(compose, /RABBITMQ_/);
  assert.doesNotMatch(platformEnv, /^REDIS_/m);
  assert.doesNotMatch(platformEnv, /^RABBITMQ_/m);
});

test('shared runtime cache has an explicit bound and no legacy config name', () => {
  assert.match(cache, /RUNTIME_CACHE_MAX_ENTRIES\) \|\| 500/);
  assert.doesNotMatch(cache, /LEGACY_CACHE_MAX_ENTRIES/);
});
