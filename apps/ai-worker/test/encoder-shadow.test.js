import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TEXT_PROVIDERS = 'freellmapi';
process.env.ENCODER_URL = 'http://encoder.test';
process.env.ENCODER_SHADOW = 'true';
process.env.ENCODER_SHADOW_LOG_PER_MINUTE = '0';

const { encoderValues, compareValue, recordShadow, shadowEncoder } = await import('../src/services/encoder-shadow.js');
const { metrics } = await import('../src/util/metrics.js');

const prediction = {
  fields: { balcony: { label: 'yes', prob: 0.95 }, petsAllowed: { label: 'no', prob: 0.9 }, gas: { label: 'unsaid', prob: 0.99 }, tv: { label: 'yes', prob: 0.4 } },
  spans: {
    ADDRESS: [{ text: 'ул. Абая 5' }], DISTRICT: [{ text: 'Юнусабад' }], COMPLEX: [{ text: 'ЖК Мега Сити' }],
    DEPOSIT: [{ text: '300' }], MICRODISTRICT: [{ text: 'мкр Тархова' }], NEARBY: [{ text: 'школы' }],
  },
  price: { amount: 600, ambiguous: false, currency: { text: '$' } },
};

test('encoder values: confident flags only, the complex without its marker, an ambiguous price left out', () => {
  const v = encoderValues(prediction, { minProb: 0.8 });
  assert.deepEqual(v, { balcony: true, petsAllowed: false, address: 'ул. Абая 5', district: 'Юнусабад', residenceComplex: 'Мега Сити', priceAmount: 600, priceCurrency: '$', depositAmount: 300 });
  assert.equal(encoderValues({ ...prediction, price: { ...prediction.price, ambiguous: true } }, { minProb: 0.8 }).priceAmount, undefined);
  assert.equal(encoderValues({ spans: { DEPOSIT: [{ text: '2 месяца' }] } }).depositAmount, undefined, 'a deposit in months needs the lexicon');
});

test('compare: matches, mismatches, and who has a value', () => {
  assert.equal(compareValue(true, true), 'agree');
  assert.equal(compareValue(true, false), 'disagree');
  assert.equal(compareValue('ул. Абая 5', 'Абая 5'), 'agree');
  assert.equal(compareValue('Юнусабад', 'Чиланзар'), 'disagree');
  assert.equal(compareValue(600, 600.2), 'agree');
  assert.equal(compareValue(600, 700), 'disagree');
  assert.equal(compareValue('Абая', null), 'encoderOnly');
  assert.equal(compareValue(null, 'Абая'), 'sourceOnly');
  assert.equal(compareValue(null, null), null);
});

test('recording counts per field and per source, and the kinds of place the schema has no field for', () => {
  metrics.encoderShadow.fields = {};
  metrics.encoderShadow.found = {};
  const outcomes = recordShadow(prediction, {
    knownFacts: { district: 'Yunusabad-x', address: null, priceAmount: 600 },
    data: { district: 'Юнусабад', address: 'ул. Абая 5', priceAmount: 650, balcony: true },
  });
  assert.deepEqual(outcomes.address, { parser: 'encoderOnly', llm: 'agree' });
  assert.deepEqual(outcomes.district, { parser: 'disagree', llm: 'agree' });
  assert.deepEqual(outcomes.priceAmount, { parser: 'agree', llm: 'disagree' });
  assert.equal(metrics.encoderShadow.fields.address.parser.encoderOnly, 1);
  assert.equal(metrics.encoderShadow.fields.balcony.llm.agree, 1);
  assert.deepEqual(metrics.encoderShadow.found, { MICRODISTRICT: 1, NEARBY: 1 });
});

test('shadow is fire and forget: a failing encoder is counted, never thrown, and the call returns at once', async () => {
  metrics.encoderShadow.requests = 0;
  metrics.encoderShadow.failures = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const returned = shadowEncoder({ text: 'Сдаётся 2к, ул. Абая 5', knownFacts: {} }, {});
    assert.equal(returned, undefined);
    assert.equal(metrics.encoderShadow.requests, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(metrics.encoderShadow.failures, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('shadow does nothing for an empty text', () => {
  metrics.encoderShadow.requests = 0;
  shadowEncoder({ text: '   ' }, {});
  assert.equal(metrics.encoderShadow.requests, 0);
});
