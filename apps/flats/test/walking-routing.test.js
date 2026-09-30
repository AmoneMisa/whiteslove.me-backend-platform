import test from 'node:test';
import assert from 'node:assert/strict';
import { __walkingRoutingTest, fetchWalkingMatrix } from '../src/geo/walking-routing.js';

test('Valhalla walking matrix uses pedestrian costing and converts km/seconds', async () => {
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          sources_to_targets: [[
            { distance: 0.782, time: 587 },
            { distance: 1.106, time: 824 },
          ]],
        };
      },
    };
  };

  const result = await fetchWalkingMatrix(
    { lat: 41.31, lng: 69.28 },
    [
      { lat: 41.315, lng: 69.285 },
      { lat: 41.32, lng: 69.29 },
    ],
    { baseUrl: 'http://valhalla:8002/', fetchImpl: fakeFetch, requestTimeoutMs: 5000 },
  );

  assert.equal(request.url, 'http://valhalla:8002/sources_to_targets');
  assert.equal(request.options.method, 'POST');
  const body = JSON.parse(request.options.body);
  assert.equal(body.costing, 'pedestrian');
  assert.equal(body.units, 'kilometers');
  assert.deepEqual(body.sources, [{ lat: 41.31, lon: 69.28 }]);
  assert.deepEqual(result, [
    { distanceM: 782, durationMin: 10 },
    { distanceM: 1106, durationMin: 14 },
  ]);
});

test('walking matrix can be disabled without inventing route distances', async () => {
  let called = false;
  const result = await fetchWalkingMatrix(
    { lat: 41.31, lng: 69.28 },
    [{ lat: 41.315, lng: 69.285 }],
    {
      baseUrl: 'off',
      fetchImpl: async () => {
        called = true;
        throw new Error('must not be called');
      },
    },
  );

  assert.equal(called, false);
  assert.deepEqual(result, [null]);
});

test('walking matrix preserves target positions when one target is invalid', async () => {
  const result = await fetchWalkingMatrix(
    { lat: 41.31, lng: 69.28 },
    [
      { lat: 41.315, lng: 69.285 },
      { lat: null, lng: 69.29 },
      { lat: 41.32, lng: 69.30 },
    ],
    {
      baseUrl: 'http://valhalla:8002',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            sources_to_targets: [[
              { distance: 0.5, time: 360 },
              { distance: 0.9, time: 660 },
            ]],
          };
        },
      }),
    },
  );

  assert.deepEqual(result, [
    { distanceM: 500, durationMin: 6 },
    null,
    { distanceM: 900, durationMin: 11 },
  ]);
});

test('the retired demo host is rewritten to the FOSSGIS routing API', async () => {
  // valhalla.openstreetmap.de now serves only the demo app and answers the
  // matrix POST with 405; .env.example used to point production at it.
  assert.equal(__walkingRoutingTest.DEFAULT_VALHALLA_URL, 'https://valhalla1.openstreetmap.de');
  assert.equal(__walkingRoutingTest.normalizedBaseUrl('https://valhalla.openstreetmap.de/'), 'https://valhalla1.openstreetmap.de');
  assert.equal(__walkingRoutingTest.normalizedBaseUrl('https://routing.example.org/'), 'https://routing.example.org');

  __walkingRoutingTest.resetFailureCooldown();
  const urls = [];
  await fetchWalkingMatrix({ lat: 41.2757, lng: 69.2047 }, [{ lat: 41.2733, lng: 69.2043 }], {
    baseUrl: 'https://valhalla.openstreetmap.de',
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ sources_to_targets: [[{ distance: 0.346, time: 261 }]] }), { status: 200 });
    },
  });
  assert.deepEqual(urls, ['https://valhalla1.openstreetmap.de/sources_to_targets']);
});

test('a failing router is skipped for a cool-down instead of costing every popup', async () => {
  __walkingRoutingTest.resetFailureCooldown();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return new Response('<html>405 Not Allowed</html>', { status: 405 });
  };
  const origin = { lat: 41.2757, lng: 69.2047 };
  const targets = [{ lat: 41.2733, lng: 69.2043 }];
  const now = Date.parse('2026-09-30T08:00:00Z');

  await assert.rejects(fetchWalkingMatrix(origin, targets, { baseUrl: 'https://r.example', fetchImpl: failing, now }), /HTTP 405/u);
  assert.deepEqual(await fetchWalkingMatrix(origin, targets, { baseUrl: 'https://r.example', fetchImpl: failing, now: now + 60_000 }), [null]);
  assert.equal(calls, 1, 'no request during the cool-down');

  await assert.rejects(fetchWalkingMatrix(origin, targets, { baseUrl: 'https://r.example', fetchImpl: failing, now: now + 6 * 60_000 }), /HTTP 405/u);
  assert.equal(calls, 2, 'retried after the cool-down');
  __walkingRoutingTest.resetFailureCooldown();
});
