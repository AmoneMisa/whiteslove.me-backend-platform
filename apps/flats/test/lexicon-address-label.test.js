import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLexiconAddress } from '../src/listing/lexicon-parse.js';

test('a labelled line without a street is not echoed as the address', () => {
  assert.equal(parseLexiconAddress("Manzil: Sergeli 5 104 ( o'zgarish netrosi yonida)\nXona: 2 xonali\nNarxi: 900 000"), null);
});

test('a labelled Uzbek street keeps street and house only', () => {
  assert.equal(parseLexiconAddress("Manzil: Qatortol ko'chasi 45 uy, Sergeli"), 'Qatortol 45');
});
