import test from 'node:test';
import assert from 'node:assert/strict';

import {closeDb, pool, upsertListings} from '../src/db.js';
import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';

function input(id, overrides = {}) {
  return {
    id,
    source: 'olx',
    country: 'UZ',
    title: 'Contract preservation test',
    description: 'Synthetic integration-test listing',
    propertyType: 'flat',
    dealType: 'longRent',
    byAgency: false,
    price: 500,
    currency: 'USD',
    rooms: 2,
    areaSqm: 50,
    city: 'Tashkent',
    createdAt: new Date().toISOString(),
    url: `https://example.test/${id}`,
    ...overrides,
  };
}

test('upsert preserves absent normalized keys but honors explicit replacements', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  const id = 'data-preservation-test-1';

  try {
    await pool.query(
      `DELETE FROM listings WHERE source = 'olx' AND country = 'UZ' AND source_id = $1`,
      [id],
    );

    await upsertListings([input(id, {
      vision: {provider: 'test', derivedFields: ['parking']},
      locationAccuracyM: 25,
      futureContractField: {version: 1},
    })]);

    await upsertListings([input(id, {
      title: 'Fresh source title',
      price: 550,
    })]);

    let result = await pool.query(`
      SELECT title, price, data
      FROM listings
      WHERE source = 'olx' AND country = 'UZ' AND source_id = $1
    `, [id]);

    assert.equal(result.rows[0]?.title, 'Fresh source title');
    assert.equal(Number(result.rows[0]?.price), 550);
    assert.deepEqual(result.rows[0]?.data?.vision, {
      provider: 'test',
      derivedFields: ['parking'],
    });
    assert.equal(result.rows[0]?.data?.locationAccuracyM, 25);
    assert.deepEqual(result.rows[0]?.data?.futureContractField, {version: 1});

    await upsertListings([input(id, {
      vision: null,
      locationAccuracyM: null,
      futureContractField: null,
    })]);

    result = await pool.query(`
      SELECT data
      FROM listings
      WHERE source = 'olx' AND country = 'UZ' AND source_id = $1
    `, [id]);

    assert.equal(result.rows[0]?.data?.vision, null);
    assert.equal(result.rows[0]?.data?.locationAccuracyM, null);
    assert.equal(result.rows[0]?.data?.futureContractField, null);
  } finally {
    await pool.query(
      `DELETE FROM listings WHERE source = 'olx' AND country = 'UZ' AND source_id = $1`,
      [id],
    );
    await closeDb();
  }
});
