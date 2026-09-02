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

let lastWarningAt = 0;

const visionQueue = [];
const visionScheduled = new Set();
let activeVision = 0;

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
