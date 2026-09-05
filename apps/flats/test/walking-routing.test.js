import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWalkingMatrix } from '../src/geo/walking-routing.js';

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
