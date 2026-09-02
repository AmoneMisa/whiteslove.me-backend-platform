import test from 'node:test';
import assert from 'node:assert/strict';

import {parseLexiconAddress} from '../src/listing/lexicon-parse.js';
import {maskPhoneLikeSpans} from '@whiteslove/parsing-lexicon/contact';
import {parseHousingPrice} from '@whiteslove/parsing-lexicon/housing-money';

const wantedChernivtsi = `Добрий день! Шукаю 1-к. кв. або підселення в непрохідну окрему кімнату.
Бюджет:
Якщо кімната до 7000 грн
Якщо квартира до 10 000 грн
095 082 01 03 Марія`;

test('phone-like digit groups cannot become housing prices', () => {
  assert.doesNotMatch(maskPhoneLikeSpans(wantedChernivtsi), /095\s+082\s+01\s+03/);
  assert.deepEqual(parseHousingPrice(wantedChernivtsi, 'UAH'), {
    amount: 10000,
    currency: 'UAH',
    approximate: false,
  });
});

test('compact Ukrainian street marker is parsed without a space after the dot', () => {
  assert.equal(
    parseLexiconAddress('Здам 3-х кімнатну квартиру на вул.Воробкевича. ВЛАСНИК'),
    'вул.Воробкевича',
  );
});
