import test from 'node:test';
import assert from 'node:assert/strict';

import {parseLexiconAddress} from '../src/listing/lexicon-parse.js';

test('compact Ukrainian street marker is parsed without a space after the dot', () => {
  assert.equal(
    parseLexiconAddress('Здам 3-х кімнатну квартиру на вул.Воробкевича. ВЛАСНИК'),
    'вул.Воробкевича',
  );
});
