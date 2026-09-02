import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OLX_FETCHER_URL = 'http://olx-fetcher.test';

const {closeDb, pool, upsertListings} = await import('../src/infrastructure/database/listingRepository.js');
const {assertDatabaseReady} = await import('../src/infrastructure/database/schemaReady.js');
const {
  recordListingAvailability,
  verifyListingAvailability,
} = await import('../src/availability/availability.js');

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';

test('forced OLX availability bypasses fresh active cache and persists inactive state', {skip: !enabled}, async (t) => {
  await assertDatabaseReady();

  const id = 'availability-force-test-1';
  const originalFetch = globalThis.fetch;

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await pool.query(
      `DELETE FROM listings WHERE source = 'olx' AND country = 'UZ' AND source_id = $1`,
      [id],
    );
    await closeDb();
  });

  await pool.query(
    `DELETE FROM listings WHERE source = 'olx' AND country = 'UZ' AND source_id = $1`,
    [id],
  );

  await upsertListings([{
    id,
    source: 'olx',
    country: 'UZ',
    title: 'Forced availability test apartment',
    description: 'Synthetic forced-refresh integration-test listing',
    propertyType: 'flat',
    dealType: 'longRent',
    byAgency: false,
    price: 410,
    currency: 'USD',
    rooms: 2,
    areaSqm: 48,
    city: 'Tashkent',
    createdAt: new Date().toISOString(),
    url: 'https://www.olx.uz/d/obyavlenie/test-ID4sbYt.html',
  }]);

  await recordListingAvailability({
    source: 'olx',
    country: 'UZ',
    id,
    status: 'active',
    reason: 'offer_payload',
  });

  let fetchCalls = 0;
  globalThis.fetch = async (_url, options) => {
    fetchCalls += 1;
    assert.equal(options?.method, 'POST');
    assert.deepEqual(JSON.parse(options?.body || '{}'), {
      id: '4sbYt',
      url: 'https://www.olx.uz/d/obyavlenie/test-ID4sbYt.html',
    });
    return new Response(JSON.stringify({
      status: 'inactive',
      reason: 'missing_offer_payload',
    }), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };

  const cached = await verifyListingAvailability([{
    source: 'olx',
    country: 'UZ',
    id,
  }]);

  assert.equal(cached[0]?.status, 'active');
  assert.equal(cached[0]?.cached, true);
  assert.equal(fetchCalls, 0);

  const forced = await verifyListingAvailability([{
    source: 'olx',
    country: 'UZ',
    id,
  }], {force: true});

  assert.equal(fetchCalls, 1);
  assert.equal(forced[0]?.status, 'inactive');
  assert.equal(forced[0]?.reason, 'missing_offer_payload');
  assert.equal(forced[0]?.cached, false);
  assert.ok(forced[0]?.inactiveAt);

  const state = await pool.query(`
    SELECT active, availability_status, availability_reason, inactive_at
    FROM listings
    WHERE source = 'olx' AND country = 'UZ' AND source_id = $1
  `, [id]);

  assert.equal(state.rows[0]?.active, false);
  assert.equal(state.rows[0]?.availability_status, 'inactive');
  assert.equal(state.rows[0]?.availability_reason, 'missing_offer_payload');
  assert.ok(state.rows[0]?.inactive_at);
});
