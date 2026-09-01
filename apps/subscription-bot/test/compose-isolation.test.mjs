import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
const botBlock = compose.match(/\n  subscription-bot:\n([\s\S]*?)(?=\nvolumes:\n)/)?.[1] || '';
const dependencies = botBlock.match(/    depends_on:\n([\s\S]*?)(?=    networks:)/)?.[1] || '';

test('subscription bot depends only on its own migration', () => {
  assert.match(dependencies, /subscriptions-migrate:/);
  assert.doesNotMatch(dependencies, /(?:flats|vacancies|cv)-(?:api|worker|migrate):/);
  assert.doesNotMatch(dependencies, /frontend:/);
});

test('subscription services have their own deployment domain', () => {
  assert.match(compose, /me\.whiteslove\.platform\.domain: subscriptions/);
  assert.match(compose, /subscriptions-migrate:/);
});
