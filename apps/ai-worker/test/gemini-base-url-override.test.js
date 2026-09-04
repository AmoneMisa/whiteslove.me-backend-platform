import test from 'node:test';
import assert from 'node:assert/strict';

// Gemini's default endpoint blocks some regions ("User location is not
// supported for the API use"). GEMINI_BASE_URL lets a deployment substitute a
// same-protocol relay run somewhere Google does serve, with no other change.
process.env.VISION_PROVIDERS = 'gemini';
process.env.TEXT_PROVIDERS = 'gemini';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_BASE_URL = 'https://relay.example.internal/v1beta/openai/';

const { emptyVisionResult } = await import('../src/schemas/vision.js');
const { analyzePhotos } = await import('../src/services/vision.js');
const { extract } = await import('../src/services/extract.js');

test('vision requests go to the configured relay instead of Google directly', async () => {
  const vision = emptyVisionResult();
  vision.balcony = { value: true, confidence: 0.9, evidence: ['visible railing'] };

  const originalFetch = global.fetch;
  const calledUrls = [];
  global.fetch = async (url) => {
    calledUrls.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(vision) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await analyzePhotos(['https://example.com/flat.jpg']);
    assert.equal(result.provider, 'gemini');
    // Gemini will not follow a link, so the photo is downloaded and inlined
    // first. What matters here is where the *API* call goes.
    const apiCalls = calledUrls.filter((u) => !u.startsWith('https://example.com/'));
    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0], 'https://relay.example.internal/v1beta/openai/chat/completions');
  } finally {
    global.fetch = originalFetch;
  }
});

test('text requests go to the same configured relay', async () => {
  const originalFetch = global.fetch;
  const calledUrls = [];
  global.fetch = async (url) => {
    calledUrls.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ confidence: 0.8 }) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await extract('apartment', { text: 'квартира', knownFacts: {} });
    assert.equal(calledUrls[0], 'https://relay.example.internal/v1beta/openai/chat/completions');
  } finally {
    global.fetch = originalFetch;
  }
});
