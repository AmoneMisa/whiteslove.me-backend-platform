import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TEXT_PROVIDERS = 'encoder,apinex';
process.env.ENCODER_URL = 'http://encoder.test';
process.env.APINEX_API_KEY = 'test-apinex-key';
process.env.APINEX_BASE_URL = 'https://apinex.test/v1';
process.env.APINEX_TEXT_MODEL = 'test-free-model';

const { extract } = await import('../src/services/extract.js');
const { mergeCompletion } = await import('../src/services/text.js');

const encoderAnswer = {
  fields: {
    balcony: { label: 'yes', prob: 0.97 },
    dishwasher: { label: 'yes', prob: 0.97 }, // not in the default allowed fields
  },
  confidence: 0.92,
};
const llmAnswer = {
  rooms: 2, balcony: false, dishwasher: true, petsAllowed: false, confidence: 0.7,
};

function route(t, { llmOk = true } = {}) {
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('http://encoder.test')) {
      return new Response(JSON.stringify(encoderAnswer), { status: 200 });
    }
    if (!llmOk) return new Response('upstream down', { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(llmAnswer) } }] }), { status: 200 });
  });
  return calls;
}

test('the LLM fills what the encoder does not answer; the encoder wins where it has a value', async (t) => {
  const calls = route(t);
  const result = await extract('apartment', { text: 'Квартира с балконом и посудомойкой', knownFacts: {} });
  assert.equal(result.provider, 'encoder+apinex');
  assert.equal(result.data.balcony, true, 'encoder value beats the LLM');
  assert.equal(result.data.dishwasher, true, 'filled by the LLM, the encoder is not allowed this field');
  assert.equal(result.data.rooms, 2);
  assert.equal(result.data.petsAllowed, false);
  assert.equal(result.confidence, 0.7, 'confidence comes from the completing provider');
  assert.equal(calls.length, 2);
});

test('if the completing provider is down, the partial encoder answer is returned', async (t) => {
  route(t, { llmOk: false });
  const result = await extract('apartment', { text: 'Квартира с балконом', knownFacts: {} });
  assert.equal(result.provider, 'encoder');
  assert.equal(result.data.balcony, true);
  assert.equal(result.data.rooms, null);
});

test('mergeCompletion treats null and empty arrays as blank, false as a value', () => {
  const merged = mergeCompletion(
    { a: false, b: null, c: [], d: ['x'], confidence: 0.9 },
    { a: true, b: 1, c: ['y'], d: ['z'], confidence: 0.5 },
  );
  assert.deepEqual(merged, { a: false, b: 1, c: ['y'], d: ['x'], confidence: 0.5 });
});
