import test from 'node:test';
import assert from 'node:assert/strict';

import * as geoCatalog from '@whiteslove/geo-catalog';
import { pool } from '../src/infrastructure/database/listingRepository.js';
import { nearestAddressToMetro, nearestMetroToAddress, loadLearnedAddressesNear } from '../src/geo/learned/learned-geo-proximity.js';

// nearestAddressToMetro/nearestMetroToAddress ship in @whiteslove/geo-catalog
// from 0.5.0 onward. Guard rather than hard-assume, so an environment that
// somehow installs an older version skips these two instead of crashing the
// whole test run on a cross-repo dependency mismatch.
const LIB_RESOLVER_AVAILABLE = typeof geoCatalog.nearestAddressToMetro === 'function'
  && typeof geoCatalog.nearestMetroToAddress === 'function';
const skip = LIB_RESOLVER_AVAILABLE ? false : 'requires @whiteslove/geo-catalog@>=0.5.0 (nearestAddressToMetro/nearestMetroToAddress)';

function stubQuery(rows) {
  const original = pool.query;
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows };
  };
  return { calls, restore: () => { pool.query = original; } };
}

test('nearestAddressToMetro resolves a learned address row near a known metro station', { skip }, async () => {
  // Pushkin metro (Chilonzor line, Tashkent): 41.32195, 69.3111
  const stub = stubQuery([
    { lookup_key: 'v1|UZ|address|tashkent|test|1|', canonical_name: 'Test 1', lat: 41.3130, lng: 69.3100, accuracy_m: 40 },
    { lookup_key: 'v1|UZ|address|tashkent|far|2|', canonical_name: 'Far 2', lat: 41.0, lng: 69.0, accuracy_m: 40 },
  ]);
  try {
    const result = await nearestAddressToMetro({ country: 'UZ', city: 'tashkent', canonical: 'Pushkin' }, { maxDistanceKm: 5 });
    assert.ok(result);
    assert.equal(result.entity.canonicalName, 'Test 1');
    assert.equal(result.station.canonicalName, 'Pushkin');
    assert.ok(stub.calls[0].sql.includes("entity_type = 'address'"));
    assert.equal(stub.calls[0].params[0], 'UZ');
  } finally {
    stub.restore();
  }
});

test('nearestAddressToMetro returns null when the metro station is unknown', async () => {
  const stub = stubQuery([]);
  try {
    const result = await nearestAddressToMetro({ country: 'UZ', city: 'tashkent', canonical: 'Not A Real Station' });
    assert.equal(result, null);
    assert.equal(stub.calls.length, 0); // no point querying Postgres for an unresolvable station
  } finally {
    stub.restore();
  }
});

test('nearestAddressToMetro returns null when no learned rows are in range', async () => {
  const stub = stubQuery([]);
  try {
    const result = await nearestAddressToMetro({ country: 'UZ', city: 'tashkent', canonical: 'Pushkin' }, { maxDistanceKm: 5 });
    assert.equal(result, null);
  } finally {
    stub.restore();
  }
});

test('nearestMetroToAddress resolves the nearest station for a looked-up address row', { skip }, async () => {
  const stub = stubQuery([{ lat: 41.3130, lng: 69.3100 }]);
  try {
    const result = await nearestMetroToAddress('v1|UZ|address|tashkent|test|1|', { country: 'UZ', maxDistanceKm: 5 });
    assert.ok(result);
    assert.equal(result.station.canonicalName, 'Pushkin');
  } finally {
    stub.restore();
  }
});

test('nearestMetroToAddress returns null when the lookup_key is not found', async () => {
  const stub = stubQuery([]);
  try {
    const result = await nearestMetroToAddress('v1|UZ|address|tashkent|missing|9|', { country: 'UZ' });
    assert.equal(result, null);
  } finally {
    stub.restore();
  }
});

test('loadLearnedAddressesNear builds a bounding-box query around the given point', async () => {
  const stub = stubQuery([]);
  try {
    await loadLearnedAddressesNear('UZ', { lat: 41.32195, lng: 69.3111 }, 3, 500);
    const [sql, params] = [stub.calls[0].sql, stub.calls[0].params];
    assert.match(sql, /lat BETWEEN \$2 AND \$3/);
    assert.match(sql, /lng BETWEEN \$4 AND \$5/);
    assert.equal(params[0], 'UZ');
    assert.ok(params[1] < 41.32195 && params[2] > 41.32195);
  } finally {
    stub.restore();
  }
});
