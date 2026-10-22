import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCanonicalCity} from '../src/listing/lexicon-parse.js';

test('"город Бишкек" and "Бишкек" are the same city, and an unknown city loses the prefix', () => {
  assert.equal(parseCanonicalCity('KG', 'город Бишкек'), parseCanonicalCity('KG', 'Бишкек'));
  assert.equal(parseCanonicalCity('KG', 'г. Бишкек'), 'Bishkek');
  assert.equal(parseCanonicalCity('KG', 'город Токмак'), 'Токмак');
  assert.equal(parseCanonicalCity('UA', 'город Ялта'), 'Ялта');
});
