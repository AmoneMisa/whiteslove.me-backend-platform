import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {attachResolvedSearchGeometry} from '../src/geo/search-filter-geometry.js';
import {appendPostgresGeoFilters} from '../src/infrastructure/search/postgres-geo-filter.js';

const {Client} = pg;
const connectionString = process.env.TEST_POSTGRES_URL || '';

function resolvedFilters(input) {
  const filters = {
    city: 'Tashkent',
    ...input,
  };
  const geometry = attachResolvedSearchGeometry(filters, ['UZ']);
  return {filters, geometry};
}

async function selectIds(client, filters) {
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [];
  appendPostgresGeoFilters({where, filters, alias: 'l', add});
  const result = await client.query(`
    SELECT l.id
    FROM geo_search_points AS l
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY l.id
  `, params);
  return result.rows.map((row) => row.id);
}

test('PostgreSQL executes Tashkent district and multi-metro membership against real catalog geometry', {skip: !connectionString}, async () => {
  const client = new Client({connectionString});
  await client.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE geo_search_points (
        id text PRIMARY KEY,
        lat double precision,
        lng double precision,
        district text,
        metro text,
        metro_distance_m double precision
      ) ON COMMIT PRESERVE ROWS
    `);

    const districtOnly = resolvedFilters({district: 'Чиланзар'});
    assert.equal(districtOnly.geometry.district?.id, 'uz:tashkent:chilanzar');
    assert.equal(districtOnly.geometry.district?.canonicalName, 'Chilanzar');
    assert.ok(districtOnly.geometry.district?.boundary);

    await client.query(`
      INSERT INTO geo_search_points (id, lat, lng, district) VALUES
        ('district-center-wrong-text', 41.270121, 69.200434, 'Not Chilanzar'),
        ('outside-right-text', 41.3263444, 69.3277694, 'Chilanzar'),
        ('missing-point-canonical-text', NULL, NULL, 'Chilanzar')
    `);

    assert.deepEqual(
      await selectIds(client, districtOnly.filters),
      ['district-center-wrong-text', 'missing-point-canonical-text'],
    );

    await client.query('TRUNCATE geo_search_points');

    const metroOnly = resolvedFilters({
      metro: 'Новза,Чиланзар,Алмазар',
      metros: ['Новза', 'Чиланзар', 'Алмазар'],
      metroMaxM: 800,
    });
    assert.deepEqual(
      metroOnly.geometry.metros.map((station) => station.canonicalName),
      ['Novza', 'Chilonzor', 'Olmazor'],
    );
    assert.equal(metroOnly.geometry.unresolvedMetros.length, 0);

    await client.query(`
      INSERT INTO geo_search_points (id, lat, lng, district) VALUES
        ('near-novza', 41.2920278, 69.2233417, 'Chilanzar'),
        ('near-chilonzor', 41.2745472, 69.2047389, 'Chilanzar'),
        ('near-olmazor', 41.2556111, 69.1960139, 'Chilanzar'),
        ('far-from-selected', 41.3263444, 69.3277694, 'Mirzo Ulugbek')
    `);

    assert.deepEqual(
      await selectIds(client, metroOnly.filters),
      ['near-chilonzor', 'near-novza', 'near-olmazor'],
    );

    await client.query('TRUNCATE geo_search_points');

    const combined = resolvedFilters({
      district: 'Чиланзар',
      metro: 'Новза,Чиланзар,Алмазар',
      metros: ['Новза', 'Чиланзар', 'Алмазар'],
      metroMaxM: 800,
    });
    await client.query(`
      INSERT INTO geo_search_points (id, lat, lng, district) VALUES
        ('combined-real-match', 41.270121, 69.200434, 'Wrong source district'),
        ('combined-real-miss', 41.3263444, 69.3277694, 'Chilanzar')
    `);

    assert.deepEqual(
      await selectIds(client, combined.filters),
      ['combined-real-match'],
    );
  } finally {
    await client.end();
  }
});
