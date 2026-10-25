import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLexiconAddress } from '../src/listing/lexicon-parse.js';
import { makeListing } from '../src/listing/normalize.js';

test('a street marker must end at a word boundary ("пер" is not "первую")', () => {
  const text = 'Сдаю свою первую квартиру 🥹🤍\n🏡 ЖК Ozen Park, ул. Навои, 200';
  assert.equal(parseLexiconAddress(text), 'ул. Навои, 200');
});

test('the title street does not swallow the first word of the body', () => {
  const listing = makeListing({
    id: 'olx-1', source: 'olx', country: 'UZ', city: 'Tashkent', dealType: 'longRent', url: 'u',
    title: 'Сдаётся квартира на Алмазаре, ор-р: улица Карасарай',
    description: 'Описание\n\nСдается квартира для семейных',
  });
  assert.equal(listing.address, 'улица Карасарай');
});
