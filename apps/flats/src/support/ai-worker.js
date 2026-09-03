import { createHash } from 'node:crypto';

const workerUrl = String(process.env.AI_WORKER_URL || '').replace(/\/$/, '');
const workerKey = process.env.AI_WORKER_KEY || '';
const requestTimeoutMs = Math.max(500, Number(process.env.AI_WORKER_REQUEST_TIMEOUT_MS) || 3000);
// Groq is normally fast, but when it is unavailable Cloudflare may inspect up to
// four photos sequentially. Keep the outer budget above that complete fallback
// path instead of aborting the request while the second provider is still useful.
const visionTimeoutMs = Math.max(5000, Number(process.env.AI_WORKER_VISION_TIMEOUT_MS) || 150000);
const visionConcurrency = Math.max(1, Number(process.env.AI_WORKER_VISION_CONCURRENCY) || 1);
const visionMaxQueued = Math.max(1, Number(process.env.AI_WORKER_VISION_MAX_PENDING) || 30);
// Text extraction is background enrichment, so it gets a longer budget than the
// interactive control-plane timeout and a slow poll for queued jobs.
const textTimeoutMs = Math.max(10_000, Number(process.env.AI_WORKER_TEXT_TIMEOUT_MS) || 30_000);
const textPollIntervalMs = Math.max(1_000, Number(process.env.AI_WORKER_POLL_MS) || 5_000);
const textConcurrency = Math.max(1, Number(process.env.AI_WORKER_SUBMIT_CONCURRENCY) || 2);
const textMaxQueued = Math.max(1, Number(process.env.AI_WORKER_MAX_PENDING) || 60);

let lastWarningAt = 0;

const visionQueue = [];
const visionScheduled = new Set();
let activeVision = 0;

const textQueue = [];
const textScheduled = new Set();
const textPending = new Map();
let activeText = 0;
let textPollTimer;

function warn(message) {
  if (Date.now() - lastWarningAt < 60_000) return;
  lastWarningAt = Date.now();
  console.warn(`[ai-worker] ${message}`);
}

export function visionFingerprint(images) {
  return createHash('sha256')
    .update((images || []).map((image) => String(image?.url || image || '')).join('\0'))
    .digest('hex')
    .slice(0, 24);
}

/** Stable ordering so the same facts always hash to the same fingerprint. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function aiFingerprint(kind, rawText, knownFacts) {
  return createHash('sha256')
    .update(`${kind}\0${String(rawText || '').replace(/\s+/g, ' ').trim()}\0${stable(knownFacts ?? {})}`)
    .digest('hex')
    .slice(0, 24);
}

export function aiWorkerEnabled() {
  return Boolean(workerUrl);
}

async function request(path, init = {}, timeoutMs = requestTimeoutMs) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  if (workerKey) headers.set('x-ai-key', workerKey);
  const response = await fetch(`${workerUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function submitVision(task) {
  try {
    const result = await request('/ai/vision', {
      method: 'POST',
      body: JSON.stringify({ images: task.images }),
    }, visionTimeoutMs);
    if (result.status === 'completed') await task.onResult?.(result);
    else await task.onFailed?.(result.status || 'failed');
  } catch (error) {
    warn(`vision unavailable: ${error.message}`);
    await task.onFailed?.('unavailable');
  } finally {
    visionScheduled.delete(task.fingerprint);
    activeVision -= 1;
    pumpVision();
  }
}

function pumpVision() {
  while (activeVision < visionConcurrency && visionQueue.length) {
    const task = visionQueue.shift();
    activeVision += 1;
    void submitVision(task);
  }
}

export function scheduleVisionAnalysis(task) {
  if (!aiWorkerEnabled() || !Array.isArray(task.images) || !task.images.length) return false;
  const fingerprint = task.fingerprint || visionFingerprint(task.images);
  if (visionScheduled.has(fingerprint) || visionQueue.length + activeVision >= visionMaxQueued) return false;
  visionScheduled.add(fingerprint);
  visionQueue.push({ ...task, fingerprint });
  pumpVision();
  return true;
}


async function finishText(task, result) {
  textScheduled.delete(task.fingerprint);
  try {
    await task.onResult?.(result);
  } catch (error) {
    warn(`result merge failed for ${task.id}: ${error.message}`);
  }
}

async function failText(task, status) {
  textScheduled.delete(task.fingerprint);
  try {
    await task.onFailed?.(status);
  } catch (error) {
    warn(`failure callback failed for ${task.id}: ${error.message}`);
  }
}

function scheduleTextPoll() {
  if (textPollTimer || textPending.size === 0) return;
  textPollTimer = setTimeout(() => {
    textPollTimer = undefined;
    void pollTextPending();
  }, textPollIntervalMs);
  textPollTimer.unref?.();
}

async function pollTextPending() {
  const batch = [...textPending.entries()].slice(0, textConcurrency * 2);
  await Promise.all(batch.map(async ([key, task]) => {
    try {
      const result = await request(`/ai/result/${encodeURIComponent(key)}`, {}, textTimeoutMs);
      if (result.status === 'completed') {
        textPending.delete(key);
        await finishText(task, result);
      } else if (['failed', 'not_found', 'disabled'].includes(result.status)) {
        textPending.delete(key);
        await failText(task, result.status);
      }
    } catch (error) {
      warn(`poll unavailable: ${error.message}`);
    }
  }));
  scheduleTextPoll();
}

async function submitText(task) {
  try {
    const result = await request('/ai/extract', {
      method: 'POST',
      body: JSON.stringify({
        kind: task.kind,
        rawText: task.rawText,
        knownFacts: task.knownFacts || {},
        meta: task.meta || {},
      }),
    }, textTimeoutMs);

    if (result.status === 'completed') await finishText(task, result);
    else if (result.status === 'pending' && result.key) {
      textPending.set(result.key, task);
      scheduleTextPoll();
    } else await failText(task, result.status || 'failed');
  } catch (error) {
    warn(`extraction unavailable: ${error.message}`);
    await failText(task, 'unavailable');
  } finally {
    activeText -= 1;
    pumpText();
  }
}

function pumpText() {
  while (activeText < textConcurrency && textQueue.length) {
    const task = textQueue.shift();
    activeText += 1;
    void submitText(task);
  }
}

/**
 * Queues one `/ai/extract` job. Returns false when the worker is disabled, the
 * text is empty, the same facts are already in flight, or the queue is full —
 * callers keep their deterministic parse in every one of those cases.
 */
export function scheduleAiExtraction(task) {
  if (!aiWorkerEnabled() || !String(task?.rawText || '').trim()) return false;
  const fingerprint = task.fingerprint || aiFingerprint(task.kind, task.rawText, task.knownFacts);
  if (textScheduled.has(fingerprint)) return false;
  if (textQueue.length + textPending.size + activeText >= textMaxQueued) return false;

  textScheduled.add(fingerprint);
  textQueue.push({ ...task, fingerprint });
  pumpText();
  return true;
}
