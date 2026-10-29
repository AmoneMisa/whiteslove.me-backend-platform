import test from 'node:test';
import assert from 'node:assert/strict';
import { lexiconEntries, lexiconPlaceNames } from '../src/ml/lexicon-names.js';

test('entries are found by walking nested dictionaries; metro and district names are split by type', () => {
  const source = {
    A: [{ type: 'metro', canonical: 'Oybek', aliases: ['Oybek', 'Ойбек'] }],
    B: { Tashkent: { districts: [{ entityType: 'district', canonical: 'Chilanzar', aliases: { ru: ['Чиланзар'], en: ['Chilanzar'] } }] } },
    C: [{ type: 'street', canonical: 'Navoi', aliases: ['Навои'] }, { canonical: 'no type', aliases: ['x'] }],
  };
  assert.equal(lexiconEntries(source).length, 3);
  const names = lexiconPlaceNames(source);
  assert.deepEqual(names.metro, ['Oybek', 'Ойбек']);
  assert.deepEqual(names.districts, ['Chilanzar', 'Чиланзар']);
  assert.deepEqual(names.metroGroups, [['Oybek', 'Oybek', 'Ойбек']]);
});

test('the real lexicon knows the spellings the database does not store', () => {
  const { metro } = lexiconPlaceNames();
  assert.ok(metro.includes('Дружба народов'));
  assert.ok(metro.some((n) => /Ойбек/.test(n)));
});
