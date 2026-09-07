import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.env.TEXT_PROVIDERS = 'apinex';
process.env.APINEX_API_KEY = 'test-apinex-key';
process.env.APINEX_BASE_URL = 'https://apinex.test/v1/';
process.env.APINEX_TEXT_MODEL = 'test-free-model';
process.env.GROQ_API_KEY = 'test-fallback-key';

const { extract } = await import('../src/services/extract.js');
const { runText } = await import('../src/services/text.js');
const answer = () => new Response(JSON.stringify({ choices: [{ message: {
  content: JSON.stringify({ confidence: 0.9 }),
} }] }), { status: 200 });

test('APInex supports all three extraction schemas with configured auth and model', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return answer();
  });
  for (const kind of ['apartment', 'candidate', 'vacancy']) {
    const result = await extract(kind, { text: 'Sample description', knownFacts: {} });
    assert.equal(result.provider, 'apinex');
    assert.equal(result.confidence, 0.9);
    const call = calls.at(-1);
    assert.equal(call.url, 'https://apinex.test/v1/chat/completions');
    assert.equal(call.init.headers.authorization, 'Bearer test-apinex-key');
    assert.equal(call.body.model, 'test-free-model');
    assert.equal(call.body.response_format.json_schema.name, kind);
    assert.equal(call.body.response_format.json_schema.strict, true);
  }
  assert.equal(calls.length, 3);
});

test('APInex retries unsupported schema mode as JSON', async (t) => {
  const formats = [];
  t.mock.method(global, 'fetch', async (_url, init) => {
    formats.push(JSON.parse(init.body).response_format.type);
    if (formats.length === 1) return new Response('json_schema unsupported', { status: 400 });
    return answer();
  });
  assert.equal((await extract('candidate', { text: 'Developer' })).provider, 'apinex');
  assert.deepEqual(formats, ['json_schema', 'json_object']);
});

test('APInex rate limits fall through and activate the shared cooldown', async (t) => {
  const urls = [];
  t.mock.method(global, 'fetch', async (url) => {
    urls.push(url);
    return url.includes('apinex.test')
      ? new Response('quota exhausted', { status: 429, headers: { 'retry-after': '60' } })
      : answer();
  });
  for (let i = 0; i < 2; i++) {
    assert.equal((await runText({ providers: ['apinex', 'groq'], payload: {}, systemPrompt: 'JSON' })).provider, 'groq');
  }
  assert.equal(urls.filter((url) => url.includes('apinex.test')).length, 1);
  assert.equal(urls.length, 3);
});

test('missing APInex key or model never sends a request', () => {
  for (const missing of ['APINEX_API_KEY', 'APINEX_TEXT_MODEL']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { TEXT_PROVIDERS } from ${JSON.stringify(new URL('../src/services/text-providers.js', import.meta.url).href)};
      global.fetch = () => { throw new Error('unexpected network request'); };
      await assert.rejects(TEXT_PROVIDERS.apinex({}), { code: 'TEXT_PROVIDER_NOT_CONFIGURED' });
    `], { env: { ...process.env, [missing]: '' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
