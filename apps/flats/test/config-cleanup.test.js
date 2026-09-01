import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
const sampleEnv = readFileSync(new URL('../../sample.env', import.meta.url), 'utf8');

test('retired scheduler toggles stay out of runtime config', () => {
  assert.doesNotMatch(compose, /DISABLE_SCHEDULER/);
  assert.doesNotMatch(sampleEnv, /^REFRESH_MINUTES=/m);
  assert.doesNotMatch(sampleEnv, /DISABLE_SCHEDULER/);
});

test('retired Redis and RabbitMQ infrastructure stays absent', () => {
  assert.doesNotMatch(compose, /flat-finder-redis:/);
  assert.doesNotMatch(compose, /flat-finder-rabbitmq:/);
  assert.doesNotMatch(compose, /REDIS_URL=/);
  assert.doesNotMatch(compose, /RABBITMQ_/);
  assert.doesNotMatch(sampleEnv, /^REDIS_/m);
  assert.doesNotMatch(sampleEnv, /^RABBITMQ_/m);
});

test('shared runtime cache has an explicit bound and no legacy config name', () => {
  assert.match(sampleEnv, /^RUNTIME_CACHE_MAX_ENTRIES=500$/m);
  assert.doesNotMatch(sampleEnv, /LEGACY_CACHE_MAX_ENTRIES/);
});
