const workerUrl = String(process.env.AI_WORKER_URL || '').replace(/\/$/, '');
const workerKey = process.env.AI_WORKER_KEY || '';
const requestTimeoutMs = Math.max(
  1000,
  Number(process.env.AI_WORKER_REQUEST_TIMEOUT_MS) || 10_000,
);

const targetLanguages = new Map([
  ['ru', 'Russian'],
  ['russian', 'Russian'],
  ['русский', 'Russian'],
  ['en', 'English'],
  ['english', 'English'],
]);

function normalizeTargetLanguage(value) {
  const key = String(value || '').trim().toLowerCase();
  return targetLanguages.get(key) || null;
}

async function workerRequest(path, init = {}) {
  if (!workerUrl) {
    const error = new Error('AI worker is not configured');
    error.code = 'AI_DISABLED';
    throw error;
  }

  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  if (workerKey) headers.set('x-ai-key', workerKey);

  const response = await fetch(`${workerUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `AI worker HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function sendWorkerError(res, error) {
  if (error?.code === 'AI_DISABLED') {
    return res.status(503).json({ status: 'disabled', error: error.message });
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return res.status(504).json({ status: 'unavailable', error: 'AI worker request timed out' });
  }
  const status = Number(error?.status);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ status: 'failed', error: error.message });
  }
  return res.status(502).json({ status: 'unavailable', error: error?.message || 'AI worker unavailable' });
}

export function installTranslationRoutes(app) {
  if (app.locals.translationRoutesInstalled) return;
  app.locals.translationRoutesInstalled = true;

  app.post('/api/translation', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Missing text' });
    if (text.length > 32_000) {
      return res.status(413).json({ error: 'Text exceeds 32000 characters' });
    }

    const targetLanguage = normalizeTargetLanguage(req.body?.targetLanguage);
    if (!targetLanguage) {
      return res.status(400).json({ error: 'targetLanguage must be ru|en' });
    }

    try {
      const result = await workerRequest('/ai/extract', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'translation',
          rawText: text,
          knownFacts: { targetLanguage },
          meta: {
            app: 'flat-finder',
            interactive: true,
          },
        }),
      });
      return res.json(result);
    } catch (error) {
      return sendWorkerError(res, error);
    }
  });

  app.get('/api/translation/:key', async (req, res) => {
    const key = String(req.params.key || '');
    if (!/^translation-[a-f0-9]{32}$/.test(key)) {
      return res.status(400).json({ error: 'Invalid translation key' });
    }

    try {
      const result = await workerRequest(`/ai/result/${encodeURIComponent(key)}`);
      return res.json(result);
    } catch (error) {
      return sendWorkerError(res, error);
    }
  });
}
