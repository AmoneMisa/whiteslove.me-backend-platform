import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {closeDb, pool} from '../src/db.js';
import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';

test('overlapping property cluster merges converge on one canonical cluster', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  const suffix = randomUUID();
  const source = 'cluster-concurrency-test';
  const members = ['a', 'b', 'c'].map((id) => ({
    source,
    country: 'ZZ',
    source_id: `${suffix}-${id}`,
  }));

  try {
    const merge = (subset, proposed) => pool.query(
      'SELECT merge_listing_property_cluster($1::jsonb, $2::text) AS cluster',
      [JSON.stringify(subset), proposed],
    );

    const [left, right] = await Promise.all([
      merge([members[0], members[1]], `property:${suffix.slice(0, 12)}-left`),
      merge([members[1], members[2]], `property:${suffix.slice(0, 12)}-right`),
    ]);

    assert.ok(left.rows[0]?.cluster?.id);
    assert.ok(right.rows[0]?.cluster?.id);

    const stored = await pool.query(`
      SELECT source_id, cluster_id
      FROM listing_property_clusters
      WHERE source = $1
        AND country = 'ZZ'
        AND source_id = ANY($2::text[])
      ORDER BY source_id
    `, [source, members.map((member) => member.source_id)]);

    assert.equal(stored.rows.length, 3);
    assert.equal(new Set(stored.rows.map((row) => row.cluster_id)).size, 1);
  } finally {
    await pool.query(`
      DELETE FROM listing_property_clusters
      WHERE source = $1
        AND country = 'ZZ'
        AND source_id = ANY($2::text[])
    `, [source, members.map((member) => member.source_id)]);
    await closeDb();
  }
});
