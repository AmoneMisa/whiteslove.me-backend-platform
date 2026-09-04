import test from 'node:test';
import assert from 'node:assert/strict';

// Set before anything pulls config: ESM hoists static imports, so these tests
// reach the provider through dynamic import instead.
process.env.VISION_PROVIDERS = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';

const { analyzePhotos } = await import('../src/services/vision.js');
const { VISION_FIELDS } = await import('../src/schemas/vision.js');

// A vision answer is validated field by field. A model that reports most
// fields correctly and botches the rest used to lose everything, which is what
// the smaller free models were doing on almost every request.

async function visionAnswering(text) {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).startsWith('https://photos.example.com/')) {
      return new Response(Buffer.from('jpeg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    // A fresh URL each call, so the vision cache never answers for us.
    return await analyzePhotos([`https://photos.example.com/${Math.random()}.jpg`]);
  } finally {
    global.fetch = originalFetch;
  }
}

test('the good fields survive when some fields are malformed', async () => {
  const result = await visionAnswering(JSON.stringify({
    balcony: { value: true, confidence: 0.9, evidence: ['photo_1'] },
    roomsVisible: 3,
    dishwasherVisible: 0,
  }));
  assert.equal(result.data.balcony.value, true);
  // The malformed ones are dropped rather than guessed at: coercing them would
  // invent a confidence the model never gave.
  assert.equal(result.data.roomsVisible.value, null);
  assert.equal(result.data.dishwasherVisible.value, null);
});

test('an answer where every field is malformed is still a failure', async () => {
  // Nothing usable came back, so the listing must stay unanalysed and be
  // retried, not recorded as done with an empty result.
  await assert.rejects(
    () => visionAnswering(JSON.stringify({ roomsVisible: 6, balcony: true, furnished: true })),
    /VISION_PROVIDERS_FAILED/,
  );
});

test('an unknown key alongside good fields does not lose them', async () => {
  const result = await visionAnswering(JSON.stringify({
    swimmingPoolVisible: { value: true, confidence: 1, evidence: ['photo_1'] },
    balcony: { value: true, confidence: 0.8, evidence: ['photo_1'] },
  }));
  assert.equal(result.data.balcony.value, true);
  assert.equal(Object.keys(result.data).length, VISION_FIELDS.length);
  assert.ok(!('swimmingPoolVisible' in result.data));
});

test('a single {value,...} object with no field names is a failure', async () => {
  // Observed from smaller models: they collapse the whole answer to one field.
  await assert.rejects(
    () => visionAnswering(JSON.stringify({ value: 1, confidence: 0.5, evidence: [] })),
    /VISION_PROVIDERS_FAILED/,
  );
});

test('prose around a mostly-good answer still yields the good fields', async () => {
  const result = await visionAnswering(
    'Based on the provided image, here is the JSON object:\n\n'
    + JSON.stringify({ balcony: { value: true, confidence: 0.9, evidence: ['photo_1'] }, roomsVisible: 2 }),
  );
  assert.equal(result.data.balcony.value, true);
});
