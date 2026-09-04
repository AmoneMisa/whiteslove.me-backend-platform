import { config } from '../config.js';
import { EvidenceField, VISION_FIELDS, emptyVisionResult, sanitizeVision, visionJsonSchema } from '../schemas/vision.js';
import { visionPrompt } from '../prompts/vision.js';
import { fetchJson, parseModelJson } from '../util/httpProvider.js';
import { resolveFreeLlmApiKey } from '../util/freellmapiKey.js';
import { log } from '../util/logger.js';

function schemaError(reason) {
  // A bare VISION_SCHEMA_INVALID says a model's answer was rejected but not
  // what was wrong with it, which is the one thing needed to tell a model
  // that cannot follow the schema from a prompt that asks for the impossible.
  const error = new Error(`VISION_SCHEMA_INVALID: ${reason}`);
  error.code = 'VISION_SCHEMA_INVALID';
  return error;
}

function validate(value) {
  let parsedJson;
  try {
    parsedJson = parseModelJson(value);
  } catch (error) {
    throw schemaError(`not JSON (${error.message}); answer began ${JSON.stringify(String(value).slice(0, 120))}`);
  }
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw schemaError(`expected an object, got ${Array.isArray(parsedJson) ? 'array' : typeof parsedJson}`);
  }

  // Validate field by field rather than all-or-nothing. A model that reports
  // twenty-six fields correctly and botches five had all twenty-six thrown
  // away, which is most of what these smaller models were losing. A malformed
  // field is dropped -- never repaired, since inventing the confidence behind
  // an answer would let an unexplained guess reach a listing.
  const kept = {};
  const rejected = [];
  for (const field of VISION_FIELDS) {
    if (!(field in parsedJson)) continue;
    const parsedField = EvidenceField.safeParse(parsedJson[field]);
    if (parsedField.success) kept[field] = parsedField.data;
    else rejected.push(`${field}: ${parsedField.error.issues[0]?.message || 'invalid'}`);
  }

  if (!Object.keys(kept).length) {
    const detail = rejected.length
      ? `${rejected.length} field(s) all malformed -- ${rejected.slice(0, 3).join('; ')}`
      : `no known fields present; keys were ${JSON.stringify(Object.keys(parsedJson).slice(0, 6))}`;
    throw schemaError(detail);
  }

  if (rejected.length) {
    log.warn('vision answer partially usable', {
      kept: Object.keys(kept).length,
      dropped: rejected.length,
      examples: rejected.slice(0, 3),
    });
  }

  return sanitizeVision(kept);
}

function mergePhotoResults(items) {
  const out = emptyVisionResult();
  for (const item of items) {
    for (const [field, candidate] of Object.entries(item || {})) {
      if (!candidate || candidate.value == null) continue;
      const current = out[field];
      if (!current || current.value == null || candidate.confidence > current.confidence) {
        out[field] = candidate;
      } else if (typeof candidate.value === 'number' && typeof current.value === 'number') {
        out[field] = candidate.value > current.value ? candidate : current;
      } else if (candidate.value === true && current.value === true) {
        out[field] = {
          value: true,
          confidence: Math.max(current.confidence, candidate.confidence),
          evidence: [...new Set([...(current.evidence || []), ...(candidate.evidence || [])])],
        };
      }
    }
  }
  return sanitizeVision(out);
}

// Shared shape for OpenAI-compatible chat-completions vision APIs. FreeLLMAPI
// speaks this dialect and routes image requests only to vision-capable free
// endpoints. Direct providers remain available for explicit opt-in/debugging.
// What each provider will accept in one request, where that is lower than
// what we would like to send. Groq's vision model rejects a fourth image
// outright ("This model supports up to 3 images", HTTP 400), and before this
// the only way to stop that was to lower the global cap -- which threw away
// photos for every other provider too. More photos is strictly more evidence
// for the extraction, so each provider now gets as many as it can take.
const PROVIDER_IMAGE_LIMITS = Object.freeze({
  // "This model supports up to 3 images" (HTTP 400).
  groq: 3,
  // "At most 1 image(s) may be provided in one prompt" (HTTP 400).
  nvidia: 1,
});

// Providers that will not follow a link: they reject a remote image_url and
// want the bytes inline. Cloudflare says so outright ("Property image_url
// only supports base64 encoded image data"), and Gemini's OpenAI-compatible
// layer answers a remote URL with a bare INVALID_ARGUMENT. Everyone else
// takes the URL, which is far cheaper than shipping the file, so only these
// two pay the download.
const PROVIDERS_NEEDING_INLINE_IMAGES = new Set(['cloudflare', 'gemini']);

// Base64 inflates by a third, and a provider that refuses the payload costs
// the same failover hop as one that refuses the URL.
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

// A ceiling on the whole request, not just one photo. Inlining ten photos
// produces a body large enough that a relay in front of the provider rejects
// it before the model ever sees it -- Gemini behind an nginx tunnel answers
// HTTP 413 "Request Entity Too Large", and Groq 413s directly. Photos are
// added until the budget runs out, so a listing still gets analysed on as
// many as fit rather than failing outright on all of them.
const MAX_INLINE_REQUEST_BYTES = Number(process.env.AI_MAX_INLINE_REQUEST_BYTES) || 3 * 1024 * 1024;

async function toInlineImage(url) {
  if (/^data:/i.test(url)) return url;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw Object.assign(new Error(`IMAGE_FETCH_HTTP_${response.status}`), { code: 'VISION_IMAGE_FETCH_FAILED' });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
    throw Object.assign(new Error('IMAGE_TOO_LARGE_TO_INLINE'), { code: 'VISION_IMAGE_TOO_LARGE' });
  }
  const type = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  return `data:${type};base64,${buffer.toString('base64')}`;
}

/**
 * Image URLs as the given provider will accept them.
 *
 * For a provider that needs the bytes inline, photos are taken in order until
 * the request budget is spent. Dropping the tail is much better than the
 * alternative: an oversized body is refused whole, so one photo too many
 * costs the listing every photo.
 */
async function imageUrlsFor(provider, images) {
  if (!PROVIDERS_NEEDING_INLINE_IMAGES.has(provider)) return images.map((image) => image.url);

  const inlined = [];
  let budget = MAX_INLINE_REQUEST_BYTES;
  for (const image of images) {
    let dataUri;
    try {
      dataUri = await toInlineImage(image.url);
    } catch (error) {
      // One unreachable photo should not lose the rest of the listing.
      log.warn('vision image inline failed', { provider, code: error?.code, error: error.message });
      continue;
    }
    if (dataUri.length > budget) break;
    budget -= dataUri.length;
    inlined.push(dataUri);
  }

  if (!inlined.length) {
    throw Object.assign(new Error('VISION_NO_INLINE_IMAGES'), { code: 'VISION_NO_INLINE_IMAGES' });
  }
  return inlined;
}

export function imageLimitFor(provider) {
  const limit = PROVIDER_IMAGE_LIMITS[provider];
  return limit ? Math.min(config.maxPhotosPerListing, limit) : config.maxPhotosPerListing;
}

// Providers seen to reject a json_schema response_format, remembered for the
// life of the process so the failed attempt is paid once rather than per job.
const schemaModeUnsupported = new Set();

function looksLikeSchemaRejection(error) {
  if (error?.status !== 400 && error?.status !== 422) return false;
  return /response_format|json_schema|schema|structured/i.test(error.message || '');
}

/**
 * `json_object` only obliges a model to emit valid JSON -- a bare
 * `"roomsVisible": 6` satisfies it completely. Asking for the shape in the
 * prompt and not enforcing it at decode time is why the smaller models sent
 * every answer in the wrong wrapper: holding a 31-key nested format across a
 * long generation is exactly the capability they are shortest on.
 *
 * A json_schema response_format constrains the sampler instead, so the wrong
 * shape becomes unrepresentable rather than merely discouraged.
 */
function responseFormatFor(provider) {
  if (schemaModeUnsupported.has(provider)) return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: { name: 'listing_vision', strict: true, schema: visionJsonSchema },
  };
}

async function openAiCompatibleVision(provider, { baseUrl, apiKey, model, extraBody = {} }, images) {
  if (!apiKey) {
    throw Object.assign(new Error(`${provider.toUpperCase()}_NOT_CONFIGURED`), { code: 'VISION_PROVIDER_NOT_CONFIGURED' });
  }
  const selected = images.slice(0, imageLimitFor(provider));
  const urls = await imageUrlsFor(provider, selected);
  const content = [{ type: 'text', text: visionPrompt(selected.map((image) => image.id)) }];
  for (const url of urls) content.push({ type: 'image_url', image_url: { url } });

  const send = (responseFormat) => fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: 0,
      max_completion_tokens: 3200,
      response_format: responseFormat,
      ...extraBody,
    }),
  }, provider);

  let data;
  try {
    data = await send(responseFormatFor(provider));
  } catch (error) {
    // Not every endpoint implements schema mode, and which ones do changes as
    // freellmapi routes to different upstreams. Rather than maintain a list
    // that goes stale, fall back once and remember the answer.
    if (!looksLikeSchemaRejection(error) || schemaModeUnsupported.has(provider)) throw error;
    schemaModeUnsupported.add(provider);
    log.warn('vision provider rejected schema mode, falling back to json_object', {
      provider,
      error: error.message.slice(0, 160),
    });
    data = await send({ type: 'json_object' });
  }

  return validate(data?.choices?.[0]?.message?.content);
}

async function freellmapi(images) {
  return openAiCompatibleVision('freellmapi', {
    baseUrl: config.freeLlmApiBaseUrl,
    apiKey: resolveFreeLlmApiKey({
      explicitKey: config.freeLlmApiKey,
      keyFile: config.freeLlmApiKeyFile,
    }),
    model: config.freeLlmApiVisionModel,
  }, images);
}

async function groq(images) {
  return openAiCompatibleVision('groq', {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: config.groqApiKey,
    model: config.groqVisionModel,
    extraBody: { reasoning_effort: 'none' },
  }, images);
}

async function gemini(images) {
  return openAiCompatibleVision('gemini', {
    baseUrl: config.geminiBaseUrl,
    apiKey: config.geminiApiKey,
    model: config.geminiVisionModel,
  }, images);
}

async function nvidia(images) {
  return openAiCompatibleVision('nvidia', {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: config.nvidiaApiKey,
    model: config.nvidiaVisionModel,
  }, images);
}

async function huggingface(images) {
  return openAiCompatibleVision('huggingface', {
    baseUrl: 'https://router.huggingface.co/v1',
    apiKey: config.huggingfaceApiKey,
    model: config.huggingfaceVisionModel,
  }, images);
}

async function llm7(images) {
  return openAiCompatibleVision('llm7', {
    baseUrl: 'https://api.llm7.io/v1',
    apiKey: config.llm7ApiKey,
    model: config.llm7VisionModel,
  }, images);
}

async function openrouter(images) {
  return openAiCompatibleVision('openrouter', {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: config.openrouterApiKey,
    model: config.openrouterVisionModel,
  }, images);
}

async function mistral(images) {
  return openAiCompatibleVision('mistral', {
    baseUrl: 'https://api.mistral.ai/v1',
    apiKey: config.mistralApiKey,
    model: config.mistralVisionModel,
  }, images);
}

async function cloudflare(images) {
  if (!config.cloudflareAccountId || !config.cloudflareApiToken) {
    throw Object.assign(new Error('CLOUDFLARE_NOT_CONFIGURED'), { code: 'VISION_PROVIDER_NOT_CONFIGURED' });
  }
  const results = [];
  for (const image of images) {
    const data = await fetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${config.cloudflareVisionModel}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${config.cloudflareApiToken}`, 'content-type': 'application/json' },
        // The image goes inside the message content, as base64. A
        // top-level "image" field with a URL is refused twice over:
        // "Unable to add image when there are no user-supplied nor
        // system-supplied messages", then "Malformed image URI".
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: visionPrompt([image.id]) },
              { type: 'image_url', image_url: { url: await toInlineImage(image.url) } },
            ],
          }],
          max_tokens: 3200,
        }),
      },
      'cloudflare',
    );
    const raw = data?.result?.response ?? data?.result ?? data?.response;
    results.push(validate(raw));
  }
  return mergePhotoResults(results);
}

export const VISION_PROVIDERS = Object.freeze({
  freellmapi, groq, gemini, nvidia, huggingface, llm7, openrouter, mistral, cloudflare,
});
