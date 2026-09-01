import { requireInternal } from './internal-auth.js';

const SOCIAL_FETCHER_URL = String(process.env.SOCIAL_FETCHER_URL || '').replace(/\/$/, '');

function requireSocialInternal(req, res) {
  return requireInternal(req, res, {
    envNames: ['SOCIAL_INTERNAL_KEY'],
    missingMessage: 'SOCIAL_INTERNAL_KEY/QUEUE_INTERNAL_KEY is not configured',
  });
}

async function socialRequest(path, options = {}) {
  if (!SOCIAL_FETCHER_URL) {
    throw new Error('SOCIAL_FETCHER_URL is not configured');
  }

  const response = await fetch(`${SOCIAL_FETCHER_URL}${path}`, {
    ...options,
    // This is a transport failure boundary only. If it expires, callers retry;
    // the crawl is never reported as successfully complete because of time.
    signal: AbortSignal.timeout(180_000),
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = { ok: false, error: `Social fetcher returned HTTP ${response.status}` };
  }

  return { response, body };
}

async function proxySocial(req, res, path) {
  try {
    const source = String(req.body?.source || '').toLowerCase();
    const { response, body } = await socialRequest(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, source }),
    });
    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(502).json({ ok: false, error: error?.message || String(error) });
  }
}

export function installSocialRoutes(app) {
  if (app.locals.socialRoutesInstalled) return;
  app.locals.socialRoutesInstalled = true;

  app.get('/internal/social/health', async (req, res) => {
    if (!requireSocialInternal(req, res)) return;

    try {
      const { response, body } = await socialRequest('/health');
      return res.status(response.status).json(body);
    } catch (error) {
      return res.status(503).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.post('/internal/social/crawl', async (req, res) => {
    if (!requireSocialInternal(req, res)) return;

    const source = String(req.body?.source || '').toLowerCase();
    if (!['facebook', 'threads'].includes(source)) {
      return res.status(400).json({ ok: false, error: 'crawl source must be facebook or threads' });
    }
    if (!req.body?.cutoff) {
      return res.status(400).json({ ok: false, error: 'crawl cutoff is required' });
    }
    return proxySocial(req, res, '/crawl');
  });

  app.post('/internal/social/fetch', async (req, res) => {
    if (!requireSocialInternal(req, res)) return;

    const source = String(req.body?.source || '').toLowerCase();
    if (!['facebook', 'threads', 'linkedin'].includes(source)) {
      return res.status(400).json({
        ok: false,
        error: 'source must be facebook, threads or linkedin',
      });
    }

    // Existing workers are configured with this endpoint. A semantic cutoff
    // upgrades that request to the date-bounded crawler without changing the
    // deployment contract during migration.
    if (req.body?.cutoff) {
      if (!['facebook', 'threads'].includes(source)) {
        return res.status(400).json({ ok: false, error: 'date-bounded crawl supports facebook or threads' });
      }
      return proxySocial(req, res, '/crawl');
    }

    const mode = String(req.body?.mode || '').toLowerCase();
    const threadsSearch = source === 'threads' && mode === 'search';
    const linkedinCandidates = source === 'linkedin' && mode === 'candidates';
    const path = threadsSearch
      ? '/threads/search'
      : linkedinCandidates
        ? '/linkedin/candidates'
        : '/fetch';

    return proxySocial(req, res, path);
  });
}
