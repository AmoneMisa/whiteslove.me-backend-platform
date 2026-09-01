import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLexiconAddress } from '../src/lexicon-parse.js';
import {
  parseFloor,
  parseResidentialComplex,
  parseRoomsFromText,
} from '../src/textparse-overrides.js';

const OLX_TEXT = 'Chilonzor 10 mavze 11 a dom 9 etashka 4 etajda 2 honali barcha qulayli bor';

test('parses colloquial Tashkent OLX layout and address', () => {
  assert.equal(parseRoomsFromText(OLX_TEXT), 2);
  assert.deepEqual(parseFloor(OLX_TEXT), { floor: 4, totalFloors: 9 });
  assert.equal(parseLexiconAddress(OLX_TEXT), 'Chilonzor 10 mavze, 11A');
});

test('does not promote venue and road labels into residential complexes', () => {
  assert.equal(parseResidentialComplex('PUB'), null);
  assert.equal(parseResidentialComplex('Gentelmens Pub'), null);
  assert.equal(parseResidentialComplex("Gentlemen's Pub"), null);
  assert.equal(parseResidentialComplex('Minor Restaurant'), null);
  assert.equal(parseResidentialComplex('City Hotel'), null);
  assert.equal(parseResidentialComplex("Kichik Halqa Yo'li"), null);
});
