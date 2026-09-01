import {
  hiringDbHealth,
  listHiringCandidates,
  listHiringSourceRuns,
  pruneHiringCandidates,
  recordHiringSourceRun,
  upsertHiringCandidates,
} from './hiring-db.js';

function internalKey() {
  return String(process.env.HIRING_INTERNAL_KEY || process.env.QUEUE_INTERNAL_KEY || '');
}

function requireInternal(req, res) {
  const expected = internalKey();
  if (expected.length < 16) {
    res.status(503).json({ error: 'HIRING_INTERNAL_KEY/QUEUE_INTERNAL_KEY is not configured' });
    return false;
  }
  if (String(req.get('x-queue-key') || '') !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function installHiringRoutes(app) {
  if (app.locals.hiringRoutesInstalled) return;
  app.locals.hiringRoutesInstalled = true;

  app.get('/internal/hiring/health', async (req, res) => {
    if (!requireInternal(req, res)) return;
    try {
      await hiringDbHealth();
      return res.json({ ok: true });
    } catch (error) {
      return res.status(503).json({ ok: false, error: error?.message || String(error) });
    }
  });

  app.get('/internal/hiring/candidates', async (req, res) => {
    if (!requireInternal(req, res)) return;
    try {
      const candidates = await listHiringCandidates({
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return res.json({ ok: true, count: candidates.length, candidates });
    } catch (error) {
      return res.status(500).json({ error: error?.message || String(error) });
    }
  });

  app.get('/internal/hiring/source-status', async (req, res) => {
    if (!requireInternal(req, res)) return;
    try {
      const sources = await listHiringSourceRuns();
      return res.json({ ok: true, sources });
    } catch (error) {
      return res.status(500).json({ error: error?.message || String(error) });
    }
  });

  app.post('/internal/hiring/candidates/upsert', async (req, res) => {
    if (!requireInternal(req, res)) return;

    const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    const handle = String(req.body?.handle || '').replace(/^@/, '');
    const country = String(req.body?.country || candidates[0]?.country || '').toUpperCase();
    const sourceRun = req.body?.sourceRun !== false;

    try {
      const saved = await upsertHiringCandidates(candidates, handle);
      if (sourceRun && handle) {
        await recordHiringSourceRun({
          source: 'telegram',
          handle,
          country,
          status: req.body?.status || (saved ? 'ok' : 'empty'),
          fetched: req.body?.fetched,
          candidates: req.body?.candidateCount ?? candidates.length,
          error: req.body?.error || null,
          checkedAt: req.body?.checkedAt || null,
        });
      }
      return res.json({ ok: true, saved });
    } catch (error) {
      return res.status(500).json({ error: error?.message || String(error) });
    }
  });

  app.post('/internal/hiring/source-status', async (req, res) => {
    if (!requireInternal(req, res)) return;
    const handle = String(req.body?.handle || '').replace(/^@/, '');
    if (!handle) return res.status(400).json({ error: 'Missing handle' });

    try {
      await recordHiringSourceRun({
        source: 'telegram',
        handle,
        country: req.body?.country,
        status: req.body?.status,
        fetched: req.body?.fetched,
        candidates: req.body?.candidates,
        error: req.body?.error,
        checkedAt: req.body?.checkedAt,
      });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error?.message || String(error) });
    }
  });

  app.post('/internal/hiring/prune', async (req, res) => {
    if (!requireInternal(req, res)) return;
    try {
      return res.json({ ok: true, pruned: await pruneHiringCandidates() });
    } catch (error) {
      return res.status(500).json({ error: error?.message || String(error) });
    }
  });
}
