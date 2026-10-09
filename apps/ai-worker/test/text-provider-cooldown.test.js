import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TEXT_PROVIDERS = 'groq,gemini,nvidia';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.NVIDIA_API_KEY = 'test-nvidia-key';

const { runText } = await import('../src/services/text.js');
const { failureKind, textCooldownFor } = await import('../src/util/providerCooldown.js');
const { config } = await import('../src/config.js');

const httpError = (status, message = '', extra = {}) => Object.assign(new Error(message), { status, ...extra });

test('failures are classified by what they say about the provider', () => {
  assert.equal(failureKind(httpError(429)), 'rate_limited');
  assert.equal(failureKind(httpError(502)), 'unavailable');
  assert.equal(failureKind(Object.assign(new Error('T'), { code: 'PROVIDER_TIMEOUT' })), 'unavailable');
  assert.equal(failureKind(httpError(404, 'model not found')), 'broken');
  assert.equal(failureKind(httpError(402, 'no remaining credits')), 'broken');
  assert.equal(failureKind(httpError(401)), 'broken');
  assert.equal(failureKind(httpError(400, "Model 'gpt-oss' is currently unavailable")), 'broken');
  assert.equal(failureKind(httpError(400, 'response_format json_schema is not supported')), 'request');
  assert.equal(failureKind(httpError(422, 'bad input')), 'request');
  assert.equal(failureKind(new TypeError('fetch failed')), 'network');
  assert.equal(failureKind(Object.assign(new Error('x'), { code: 'TEXT_SCHEMA_INVALID' })), 'request');
});

test('broken providers are benched longer than transient ones, request errors not at all', () => {
  assert.ok(textCooldownFor(httpError(404)) === config.textBrokenCooldownMs);
  assert.ok(textCooldownFor(httpError(404)) > textCooldownFor(httpError(503)));
  assert.equal(textCooldownFor(httpError(503)), config.visionCooldownMs);
  assert.equal(textCooldownFor(new TypeError('fetch failed')), config.visionCooldownMs);
  assert.equal(textCooldownFor(httpError(400, 'invalid request')), 0);
});

test('a 404 provider and an unreachable provider are not asked again on the next job', async () => {
  const ok = { choices: [{ message: { content: JSON.stringify({ dealType: 'rent' }) } }] };
  const hits = { groq: 0, gemini: 0, nvidia: 0 };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    if (host === 'api.groq.com') { hits.groq += 1; return new Response('{"error":"model_not_found"}', { status: 404 }); }
    if (host === 'generativelanguage.googleapis.com') { hits.gemini += 1; throw new TypeError('fetch failed'); }
    hits.nvidia += 1;
    return new Response(JSON.stringify(ok), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const call = () => runText({ schema: {}, systemPrompt: 's', payload: { text: 't' }, kind: 'apartment' });
    assert.equal((await call()).provider, 'nvidia');
    assert.equal((await call()).provider, 'nvidia');
    assert.equal((await call()).provider, 'nvidia');
    assert.deepEqual(hits, { groq: 1, gemini: 1, nvidia: 3 });
  } finally {
    global.fetch = originalFetch;
  }
});
