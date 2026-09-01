import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import { installSystemRoutes } from '../src/system-routes.js';

const systemRoutesSource = readFileSync(
  new URL('../src/system-routes.js', import.meta.url),
  'utf8',
);

function fakeApp() {
  const routes = new Map();
  return {
    locals: {},
    routes,
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('system routes expose health publicly and operations only under /internal', () => {
  const app = fakeApp();
  installSystemRoutes(app);

  assert.ok(app.routes.has('GET /health'));
  assert.ok(app.routes.has('GET /internal/db-stats'));
  assert.ok(app.routes.has('GET /internal/refresh'));
  assert.ok(app.routes.has('POST /internal/refresh'));
  assert.ok(app.routes.has('GET /internal/geo-promote'));
  assert.ok(app.routes.has('POST /internal/geo-promote'));
  assert.equal(app.routes.has('GET /api/db-stats'), false);
  assert.equal(app.routes.has('GET /api/refresh'), false);
  assert.equal(app.routes.has('POST /api/refresh'), false);
  assert.equal(app.routes.has('POST /api/geo-promote'), false);
});

test('operational routes reject unauthenticated requests before touching dependencies', async () => {
  const app = fakeApp();
  installSystemRoutes(app);

  await withEnv({ OPS_INTERNAL_KEY: null, QUEUE_INTERNAL_KEY: null }, async () => {
    const handler = app.routes.get('GET /internal/db-stats');
    const res = responseRecorder();
    await handler({ get: () => '' }, res);
    assert.equal(res.statusCode, 503);
  });

  await withEnv({ OPS_INTERNAL_KEY: 'ops-secret-123456', QUEUE_INTERNAL_KEY: null }, async () => {
    const handler = app.routes.get('POST /internal/refresh');
    const res = responseRecorder();
    await handler({ get: () => 'wrong-key' }, res);
    assert.equal(res.statusCode, 401);
  });

  await withEnv({ OPS_INTERNAL_KEY: null, QUEUE_INTERNAL_KEY: null }, async () => {
    const handler = app.routes.get('POST /internal/geo-promote');
    const res = responseRecorder();
    await handler({ get: () => '' }, res);
    assert.equal(res.statusCode, 503);
  });

  await withEnv({ OPS_INTERNAL_KEY: 'ops-secret-123456', QUEUE_INTERNAL_KEY: null }, async () => {
    const handler = app.routes.get('POST /internal/geo-promote');
    const res = responseRecorder();
    await handler({ get: () => 'wrong-key' }, res);
    assert.equal(res.statusCode, 401);
  });
});

test('geo-promote route runs the manual promotion and surfaces its result as JSON', async () => {
  const app = fakeApp();
  installSystemRoutes(app);

  // Each check gets its own withEnv call — withEnv's finally restores process.env
  // as soon as the async callback yields at its first await, not once every
  // await inside it has settled, so chaining more than one awaited handler call
  // inside a single withEnv block would read a reverted env on the later calls.
  await withEnv({ OPS_INTERNAL_KEY: 'ops-secret-123456', QUEUE_INTERNAL_KEY: null }, async () => {
    const statusHandler = app.routes.get('GET /internal/geo-promote');
    const statusRes = responseRecorder();
    await statusHandler({ get: () => 'ops-secret-123456' }, statusRes);
    assert.equal(statusRes.statusCode, 200);
    assert.ok('lastRun' in statusRes.body);
  });

  await withEnv({ OPS_INTERNAL_KEY: 'ops-secret-123456', QUEUE_INTERNAL_KEY: null }, async () => {
    const triggerHandler = app.routes.get('POST /internal/geo-promote');
    const triggerRes = responseRecorder();
    await triggerHandler({ get: () => 'ops-secret-123456' }, triggerRes);
    // No GEO_CATALOG_GITHUB_TOKEN in the test environment, so promoteLearnedGeo
    // resolves with a skipped result rather than throwing — this only asserts
    // the route wiring stays a 200 JSON response either way.
    assert.equal(triggerRes.statusCode, 200);
    assert.equal(triggerRes.body.ok, true);
    assert.ok(triggerRes.body.result);
  });
});

test('operational dependency failures stay JSON instead of falling through Express defaults', () => {
  assert.match(systemRoutesSource, /app\.post\('\/internal\/refresh'/);
  assert.match(systemRoutesSource, /res\.status\(500\)\.json\(\{/);
  assert.match(systemRoutesSource, /ok: false/);
  assert.match(systemRoutesSource, /error: err\?\.message \?\? String\(err\)/);
});
