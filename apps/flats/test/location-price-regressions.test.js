import test from 'node:test';
import assert from 'node:assert/strict';

import {parseLexiconAddress} from '../src/listing/lexicon-parse.js';

test('compact Ukrainian street marker is parsed without a space after the dot', () => {
  assert.equal(
    parseLexiconAddress('Здам 3-х кімнатну квартиру на вул.Воробкевича. ВЛАСНИК'),
    'вул.Воробкевича',
  );
});

test('the 3-letter "пер" street abbreviation does not match mid-word', () => {
  // "Відтепер" (Ukrainian: "from now on") ends in the letters "пер", which
  // is also the abbreviation for переулок/провулок (lane). Without a word
  // boundary this Telegram moderation notice was mistaken for a street
  // address and its sentence became the listing's "location".
  assert.equal(
    parseLexiconAddress('Відтепер можна знову відправляти текстові повідомлення в групу.'),
    null,
  );
});
