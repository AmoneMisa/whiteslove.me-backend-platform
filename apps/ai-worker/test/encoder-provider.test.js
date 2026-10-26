import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TEXT_PROVIDERS = 'encoder';
process.env.ENCODER_URL = 'http://encoder.test/';

const { extract } = await import('../src/services/extract.js');
const { encoderToApartment } = await import('../src/services/encoder-provider.js');

const prediction = {
  fields: {
    dishwasher: { label: 'yes', prob: 0.97 },
    petsAllowed: { label: 'no', prob: 0.9 },
    balcony: { label: 'yes', prob: 0.5 },
    gas: { label: 'unsaid', prob: 0.99 },
    internet: { label: 'yes', prob: 0.95 },
    condition: { label: 'modern', prob: 0.85 },
  },
  confidence: 0.9,
};

test('maps confident predictions, drops unsaid and low-probability ones', () => {
  const out = encoderToApartment(prediction, { minProb: 0.8, allowed: ['*'] });
  assert.equal(out.dishwasher, true);
  assert.equal(out.petsAllowed, false);
  assert.equal(out.balcony, null);
  assert.equal(out.gas, null);
  assert.equal(out.condition, 'modern');
  assert.equal(out.rooms, null);
});

test('apartment extraction goes through the encoder and passes validation', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(prediction), { status: 200 });
  });
  const result = await extract('apartment', { text: 'Есть посудомойка', knownFacts: {} });
  assert.equal(result.provider, 'encoder');
  assert.equal(result.data.internet, true);
  assert.equal(result.data.dishwasher, null, 'dishwasher is not in the default ENCODER_FIELDS');
  assert.equal(result.confidence, 0.9);
  assert.equal(calls[0].url, 'http://encoder.test/predict');
  assert.equal(calls[0].body.text, 'Есть посудомойка');
});

test('other kinds are unsupported and do not call the encoder', async (t) => {
  const fetchMock = t.mock.method(global, 'fetch', async () => new Response('{}'));
  await assert.rejects(extract('vacancy', { text: 'x', knownFacts: {} }), /TEXT_PROVIDERS_FAILED/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('only allowed fields are answered; the rest are null', () => {
  const out = encoderToApartment(prediction, { minProb: 0.8, allowed: ['dishwasher'] });
  assert.equal(out.dishwasher, true);
  assert.equal(out.petsAllowed, null);
  assert.equal(out.internet, null);
});

test('the address from the span tagger is used only when address is allowed', () => {
  const withSpans = { ...prediction, spans: { ADDRESS: [{ start: 0, end: 20, text: 'вул. Драгомирова 14а' }], METRO: [] } };
  assert.equal(encoderToApartment(withSpans, { minProb: 0.8, allowed: ['internet'] }).address, null, 'off by default');
  assert.equal(encoderToApartment(withSpans, { minProb: 0.8, allowed: ['internet', 'address'] }).address, 'вул. Драгомирова 14а');
  assert.equal(encoderToApartment(withSpans, { minProb: 0.8, allowed: ['*'] }).address, 'вул. Драгомирова 14а');
  assert.equal(encoderToApartment(prediction, { minProb: 0.8, allowed: ['address'] }).address, null, 'no spans, no address');
});
