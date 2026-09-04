// Text-only sibling of vision-providers.js: same OpenAI-compatible providers,
// no image content parts. The JSON Schema for the requested extraction kind is
// both shown to the model in the user payload and enforced at decode time via
// a json_schema response_format, so a model that cannot hold the shape across
// a long generation still cannot emit the wrong one.
import { config } from '../config.js';
import { fetchJson, parseModelJson } from '../util/httpProvider.js';
import { resolveFreeLlmApiKey } from '../util/freellmapiKey.js';
import { log } from '../util/logger.js';

function validate(value) {
  try {
    return parseModelJson(value);
  } catch {
    const error = new Error('TEXT_SCHEMA_INVALID');
    error.code = 'TEXT_SCHEMA_INVALID';
    throw error;
  }
}

// Providers seen to reject a json_schema response_format, remembered for the
// life of the process so the failed attempt is paid once rather than per job.
const schemaModeUnsupported = new Set();

function looksLikeSchemaRejection(error) {
  if (error?.status !== 400 && error?.status !== 422) return false;
  return /response_format|json_schema|schema|structured/i.test(error.message || '');
}

/**
 * `json_object` only obliges a model to emit valid JSON; it says nothing about
 * the fields we asked for. Showing the schema in the prompt and hoping is the
 * arrangement that had smaller vision models returning every answer in the
 * wrong wrapper. A json_schema response_format constrains the sampler instead.
 */
function responseFormatFor(provider, schema, name) {
  if (schemaModeUnsupported.has(provider) || !schema) return { type: 'json_object' };
  return { type: 'json_schema', json_schema: { name, strict: true, schema } };
}

async function openAiCompatibleText(provider, { baseUrl, apiKey, model, extraBody = {} }, { schema, systemPrompt, payload, kind = 'extraction' }) {
  if (!apiKey) {
    throw Object.assign(new Error(`${provider.toUpperCase()}_NOT_CONFIGURED`), { code: 'TEXT_PROVIDER_NOT_CONFIGURED' });
  }
  const send = (responseFormat) => fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({ schema, ...payload }) },
      ],
      temperature: 0,
      max_completion_tokens: 2400,
      response_format: responseFormat,
      ...extraBody,
    }),
  }, provider, { bucket: 'textProviders', timeoutMs: config.textTimeoutMs });

  let data;
  try {
    data = await send(responseFormatFor(provider, schema, kind));
  } catch (error) {
    // Not every endpoint implements schema mode, and freellmapi routes to
    // whatever upstream is alive, so support varies per request. Losing the
    // provider over an unsupported parameter is worse than sending the weaker
    // constraint, so fall back once and remember the answer.
    if (!looksLikeSchemaRejection(error) || schemaModeUnsupported.has(provider)) throw error;
    schemaModeUnsupported.add(provider);
    log.warn('text provider rejected schema mode, falling back to json_object', {
      provider,
      error: error.message.slice(0, 160),
    });
    data = await send({ type: 'json_object' });
  }

  return validate(data?.choices?.[0]?.message?.content);
}

async function freellmapi(request) {
  return openAiCompatibleText('freellmapi', {
    baseUrl: config.freeLlmApiBaseUrl,
    apiKey: resolveFreeLlmApiKey({
      explicitKey: config.freeLlmApiKey,
      keyFile: config.freeLlmApiKeyFile,
    }),
    model: config.freeLlmApiTextModel,
  }, request);
}

async function groq(request) {
  return openAiCompatibleText('groq', {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: config.groqApiKey,
    model: config.groqTextModel,
    extraBody: { reasoning_effort: 'none' },
  }, request);
}

async function gemini(request) {
  return openAiCompatibleText('gemini', {
    baseUrl: config.geminiBaseUrl,
    apiKey: config.geminiApiKey,
    model: config.geminiTextModel,
  }, request);
}

async function nvidia(request) {
  return openAiCompatibleText('nvidia', {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: config.nvidiaApiKey,
    model: config.nvidiaTextModel,
  }, request);
}

async function huggingface(request) {
  return openAiCompatibleText('huggingface', {
    baseUrl: 'https://router.huggingface.co/v1',
    apiKey: config.huggingfaceApiKey,
    model: config.huggingfaceTextModel,
  }, request);
}

async function llm7(request) {
  return openAiCompatibleText('llm7', {
    baseUrl: 'https://api.llm7.io/v1',
    apiKey: config.llm7ApiKey,
    model: config.llm7TextModel,
  }, request);
}

async function openrouter(request) {
  return openAiCompatibleText('openrouter', {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: config.openrouterApiKey,
    model: config.openrouterTextModel,
  }, request);
}

async function mistral(request) {
  return openAiCompatibleText('mistral', {
    baseUrl: 'https://api.mistral.ai/v1',
    apiKey: config.mistralApiKey,
    model: config.mistralTextModel,
  }, request);
}

export const TEXT_PROVIDERS = Object.freeze({
  freellmapi, groq, gemini, nvidia, huggingface, llm7, openrouter, mistral,
});
