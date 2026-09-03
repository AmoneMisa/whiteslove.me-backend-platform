import test from 'node:test';
import assert from 'node:assert/strict';
import { matchDictionaryEntities } from '../src/geo/location-dictionary-resolver.js';

test('dictionary resolver does not invent entities for unrelated text', () => {
  const result = matchDictionaryEntities('ordinary apartment description', 'KZ', 'Astana');
  assert.equal(result.district, null);
  assert.equal(result.microdistrict, null);
  assert.equal(result.metro, null);
  assert.equal(result.residentialComplex, null);
});
