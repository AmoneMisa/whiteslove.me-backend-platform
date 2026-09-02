import test from 'node:test';
import assert from 'node:assert/strict';

import {isDirectOwner, hasZeroCommissionSignal} from '@whiteslove/parsing-lexicon/housing-commercial';
import {parseCommission} from '../src/textparse-overrides.js';
import {classifyTelegramAgency} from '../src/scrapers/telegram.js';

const OWNER_SAMPLES = [
  'Оренда квартири від власника',
  'Здається квартира від власниці',
  'Без посередників, довгострокова оренда',
  'Без рієлтора, напряму',
  'Без ріелтора та агентств',
  'Прямо від власника',
  'Власник здає квартиру',
  'Власниця продає квартиру',
];

test('Ukrainian direct-owner phrases use one shared signal set', () => {
  for (const sample of OWNER_SAMPLES) {
    assert.equal(isDirectOwner(sample), true, sample);
    assert.equal(classifyTelegramAgency(sample), false, sample);
    assert.deepEqual(parseCommission(sample), {has: false, percent: 0}, sample);
  }
});

test('direct owner wins over channel or agency footer noise', () => {
  const sample = [
    'Оренда квартири від власника. Без посередників.',
    'Агентство нерухомості — більше пропозицій у каналі.',
    'Admin: @rent_admin',
  ].join('\n');

  assert.equal(isDirectOwner(sample), true);
  assert.equal(classifyTelegramAgency(sample), false);
  assert.deepEqual(parseCommission(sample), {has: false, percent: 0});
});

test('zero commission alone does not invent owner status', () => {
  const sample = 'Оренда квартири. Без комісії.';
  assert.equal(isDirectOwner(sample), false);
  assert.equal(hasZeroCommissionSignal(sample), true);
  assert.deepEqual(parseCommission(sample), {has: false, percent: 0});
});

test('existing Uzbek and English direct-owner signals remain supported', () => {
  for (const sample of ['Maklersiz, uy egasidan', 'Owner direct, no broker']) {
    assert.equal(isDirectOwner(sample), true, sample);
    assert.deepEqual(parseCommission(sample), {has: false, percent: 0}, sample);
  }
});
