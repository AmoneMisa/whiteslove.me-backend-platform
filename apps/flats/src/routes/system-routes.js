import {dbHealth, getDbStats} from '../infrastructure/database/listingRepository.js';
import {elasticsearchHealth} from '../infrastructure/search/elasticsearch.js';
import {requireInternal} from '../support/internal-auth.js';
import {getLastGeoPromote, getLastRun, refreshAll, refreshGeoPromote} from '../scheduling/scheduler.js';

let lastPostgresHealthWarningAt = 0;
const POSTGRES_HEALTH_WARNING_INTERVAL_MS = 30_000;

function requireOps(req, res) {
  return requireInternal(req, res, {
    envNames: ['OPS_INTERNAL_KEY'],
    missingMessage: 'OPS_INTERNAL_KEY/QUEUE_INTERNAL_KEY is not configured',
  });
}

function warnPostgresHealth(error) {
  const now = Date.now();
  if (now - lastPostgresHealthWarningAt < POSTGRES_HEALTH_WARNING_INTERVAL_MS) return;
  lastPostgresHealthWarningAt = now;
  console.warn('[health] postgres check failed:', error?.message ?? String(error));
}

export function installSystemRoutes(app) {
  if (app.locals.systemRoutesInstalled) return;
  app.locals.systemRoutesInstalled = true;

  app.get('/health', async (_req, res) => {
    let postgres = false;
    try {
      await dbHealth();
      postgres = true;
    } catch (error) {
      // Do not expose infrastructure error details in the public payload, but
      // keep a throttled server-side diagnostic so a failed container health
      // check can be explained from ordinary service logs.
      warnPostgresHealth(error);
    }

    // PostgreSQL is the primary listing/search store. Keep container readiness
    // independent from optional Elasticsearch: awaiting ES here let a degraded
    // ranking layer hold the whole 5s Docker health budget and mark a usable API
    // unhealthy. Detailed dependency health is available on the ops route.
    const ok = postgres;
    res.status(ok ? 200 : 503).json({
      ok,
      postgres,
      elasticsearch: null,
      elasticsearchStatus: null,
    });
  });

  app.get('/internal/health-details', async (req, res) => {
    if (!requireOps(req, res)) return;

    let postgres = false;
    let elasticsearch = false;
    let elasticsearchStatus = null;
    let elasticsearchError = null;
    try {
      await dbHealth();
      postgres = true;
    } catch {}
    try {
      const health = await elasticsearchHealth();
      elasticsearch = health.ok === true;
      elasticsearchStatus = health.status ?? null;
      elasticsearchError = health.error ?? null;
    } catch (error) {
      elasticsearchError = error?.message ?? String(error);
    }

    res.status(postgres ? 200 : 503).json({
      ok: postgres,
      postgres,
      elasticsearch,
      elasticsearchStatus,
      elasticsearchError,
    });
  });

  app.get('/internal/db-stats', async (req, res) => {
    if (!requireOps(req, res)) return;

    try {
      const rows = await getDbStats();
      res.json({ok: true, rows});
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err?.message ?? String(err),
      });
    }
  });

  app.get('/internal/refresh', (req, res) => {
    if (!requireOps(req, res)) return;
    res.json({lastRun: getLastRun()});
  });

  app.post('/internal/refresh', async (req, res) => {
    if (!requireOps(req, res)) return;

    try {
      const result = await refreshAll('manual');
      res.json({ok: true, result});
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err?.message ?? String(err),
      });
    }
  });

  // Promotes pending learned_geo rows (see learned-geo-export.js) into
  // @whiteslove/geo-catalog's static catalog on demand, instead of waiting
  // for refreshPlaces' once-a-day interval. Requires GEO_CATALOG_GITHUB_TOKEN
  // to be configured — see promoteLearnedGeo's own skip check for that case.
  app.get('/internal/geo-promote', (req, res) => {
    if (!requireOps(req, res)) return;
    res.json({lastRun: getLastGeoPromote()});
  });

  app.post('/internal/geo-promote', async (req, res) => {
    if (!requireOps(req, res)) return;

    try {
      const result = await refreshGeoPromote('manual');
      res.json({ok: true, result});
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err?.message ?? String(err),
      });
    }
  });
}
