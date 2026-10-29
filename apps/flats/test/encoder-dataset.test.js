import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEncoderRow, splitOf } from '../src/ml/encoder-dataset.js';

const text = 'Сдаётся квартира, есть посудомойка, с животными нельзя, евроремонт.';

test('labels yes/no/unsaid and weights by provenance tier', () => {
  const row = buildEncoderRow({
    source: 's', sourceId: '1', title: 'Квартира', description: text,
    dishwasher: true, petsAllowed: false, condition: 'modern',
    fieldProvenance: {
      dishwasher: { source: 'ai_enrichment' },
      petsAllowed: { source: 'labelled_field' },
    },
  });
  assert.equal(row.labels.dishwasher, 'yes');
  assert.equal(row.weights.dishwasher, 0.3);
  assert.equal(row.labels.petsAllowed, 'no');
  assert.equal(row.weights.petsAllowed, 0.9);
  assert.equal(row.labels.condition, 'modern');
  assert.equal(row.labels.gas, 'unsaid');
  assert.equal(row.weights.gas, 1);
});

test('redacts text and skips near-empty rows', () => {
  assert.equal(buildEncoderRow({ source: 's', id: 1, title: 'x', description: '' }), null);
  const row = buildEncoderRow(
    { source: 's', id: 2, title: '', description: `${text} +995 555 123 456` },
    { redact: (t) => t.replace(/\+995[\d ]+/, '[PHONE]') },
  );
  assert.match(row.text, /\[PHONE\]/);
});

test('split is deterministic', () => {
  assert.equal(splitOf('a:1'), splitOf('a:1'));
});

test('a stored "no" without a negated mention in the text is excluded from the loss', () => {
  const row = buildEncoderRow({
    source: 's', sourceId: '3', title: 'Квартира', description: 'Сдаётся квартира, есть балкон, рядом метро.',
    bidet: false, petsAllowed: false, balcony: true,
    fieldProvenance: { bidet: { source: 'description' }, petsAllowed: { source: 'description' } },
  });
  assert.equal(row.labels.bidet, 'no');
  assert.equal(row.weights.bidet, 0);
  assert.equal(row.weights.petsAllowed, 0);
  assert.equal(row.weights.balcony, 0.6);
});
