import test from 'node:test';
import assert from 'node:assert/strict';

import { TASHKENT_METRO, canonicalTashkentMetro } from '../src/tashkent-metro.js';
import { dictionaryLocationLists, matchDictionaryEntities } from '../src/location-dictionary-resolver.js';

test('Tashkent metro catalog contains all 50 current stations across four lines', () => {
  assert.equal(TASHKENT_METRO.length, 50);
  const counts = TASHKENT_METRO.reduce((acc, station) => {
    acc[station.line] = (acc[station.line] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { chilonzor: 17, ozbekiston: 11, yunusobod: 8, circle: 14 });
});

test('historical and colloquial aliases canonicalize to current station names', () => {
  assert.equal(canonicalTashkentMetro('Хамза'), 'Novza');
  assert.equal(canonicalTashkentMetro('Hamza'), 'Novza');
  assert.equal(canonicalTashkentMetro('Максима Горького'), 'Buyuk Ipak Yoli');
  assert.equal(canonicalTashkentMetro('БИЙ'), 'Buyuk Ipak Yoli');
  assert.equal(canonicalTashkentMetro('Bunyodkor'), 'Xalqlar Dostligi');
  assert.equal(canonicalTashkentMetro('Куйлюк'), 'Qoyliq');
});

test('country metadata exposes the complete canonical Tashkent metro list', () => {
  const meta = dictionaryLocationLists('UZ').Tashkent;
  assert.equal(meta.metro.length, 50);
  assert.equal(new Set(meta.metro).size, 50);
  assert.ok(meta.metro.includes('Novza'));
  assert.ok(meta.metro.includes('Xalqlar Dostligi'));
  assert.ok(meta.metro.includes('Qipchoq'));
});

test('parser matches old Hamza name as canonical Novza', () => {
  assert.equal(matchDictionaryEntities('Квартира рядом с метро Хамза', 'UZ', 'Tashkent').metro, 'Novza');
});
