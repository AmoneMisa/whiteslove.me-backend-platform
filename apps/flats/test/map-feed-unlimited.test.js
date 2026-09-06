import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

import {pool} from '../src/infrastructure/database/pool.js';

// Isolate map transport from the encrypted geographic catalog and shared
// filter builder, which have their own integration tests. Exercise the real
// map query and mapper without requiring production catalog credentials.
const stubs = new Map([
  [new URL('../src/geo/search-filter-geometry.js', import.meta.url).href,
    'export function copyResolvedSearchGeometry(original, filters) { return filters; }'],
  [new URL('../src/support/postgres-search.js', import.meta.url).href, `
    export function buildSearchContext({filters, countries}) {
      if (filters.offset !== 0 || filters.cursor !== '' || filters.sort !== 'newest') {
        throw new Error('Map search must ignore card pagination');
      }
      return {params: [countries], from: 'FROM listings l', where: ['l.country = ANY($1)']};
    }
  `],
]);
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (stubs.has(url)) return {format: 'module', source: stubs.get(url), shortCircuit: true};
    return nextLoad(url, context);
  },
});
let searchPostgresMapPoints;
try {
  ({searchPostgresMapPoints} = await import('../src/routes/map-feed.js'));
} finally {
  hooks.deregister();
}

test('map returns every located result beyond both former caps, ignoring card pagination', async (t) => {
  const pointCount = 10001;
  const rows = Array.from({length: pointCount}, (_, index) => ({
    db_id: index + 1,
    source_id: String(index),
    source: 'olx',
    country: 'UZ',
    lat_value: 41.3,
    lng_value: 69.2,
    total_count: pointCount + 5,
    point_count: pointCount,
  }));
  const query = t.mock.method(pool, 'query', async (sql, params) => {
    // Check the actual query sent to PostgreSQL as well as output mapping:
    // a row-mapping-only test would miss a database-side result cap.
    assert.doesNotMatch(sql, /\b(?:LIMIT|OFFSET|FETCH\s+FIRST)\b/iu);
    assert.match(sql, /visible\.lat_value BETWEEN -90 AND 90/u);
    assert.match(sql, /visible\.lng_value BETWEEN -180 AND 180/u);
    assert.match(sql, /SELECT DISTINCT ON \(dedupe_key\)/u);
    assert.deepEqual(params, [['UZ']]);
    return {rows};
  });

  const result = await searchPostgresMapPoints({
    filters: {limit: 60, offset: 120, sort: 'newest'},
    countries: ['UZ'],
  });

  assert.equal(query.mock.callCount(), 1);
  assert.equal(result.count, pointCount + 5);
  assert.equal(result.points.length, pointCount);
  assert.equal(new Set(result.points.map((point) => point.id)).size, pointCount);
  assert.equal(result.points.at(-1).id, '10000');
  assert.equal(result.truncated, false);
  assert.equal(result.maxPoints, null);
});

test('a map with no located matches preserves the total without inventing pins', async (t) => {
  t.mock.method(pool, 'query', async () => ({
    rows: [{db_id: null, total_count: 5, point_count: 0}],
  }));
  const result = await searchPostgresMapPoints({filters: {}, countries: ['UZ']});
  assert.equal(result.count, 5);
  assert.deepEqual(result.points, []);
  assert.equal(result.truncated, false);
  assert.equal(result.maxPoints, null);
});
