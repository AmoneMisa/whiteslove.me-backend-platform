import test from 'node:test';
import assert from 'node:assert/strict';

import {parseCommission} from '../src/listing/textparse-overrides.js';
import {classifyTelegramAgency} from '../src/scrapers/telegram.js';

test('direct owner wins over channel or agency footer noise', () => {
  const sample = [
    'Оренда квартири від власника. Без посередників.',
    'Агентство нерухомості — більше пропозицій у каналі.',
    'Admin: @rent_admin',
  ].join('\n');

  assert.equal(classifyTelegramAgency(sample), false);
  assert.deepEqual(parseCommission(sample), {has: false, percent: 0});
});

test('zero commission is propagated without inventing a commission', () => {
  assert.deepEqual(parseCommission('Оренда квартири. Без комісії.'), {has: false, percent: 0});
});
