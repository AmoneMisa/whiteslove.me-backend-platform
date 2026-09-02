import assert from 'node:assert/strict';
import test from 'node:test';

import {closeDb, pool} from '../src/infrastructure/database/listingRepository.js';
import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';
import {hammingDistanceHex} from '../src/photo-antifake.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';
const OLD_SOURCE = 'perceptual-recall-old';
const NOISE_SOURCE = 'perceptual-recall-noise';
const COUNTRY = 'ZZ';
const TARGET = '0000000000000000';
const OLD_VALID = '0101010101010100'; // Hamming distance 7; final byte band matches TARGET exactly.

test('indexed perceptual bands keep old valid matches discoverable after newer hashes', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  await pool.query('DELETE FROM listing_photo_hashes WHERE source = ANY($1::text[])', [[OLD_SOURCE, NOISE_SOURCE]]);

  try {
    await pool.query(`
      INSERT INTO listing_photo_hashes (
        hash, source, country, source_id, city, photo_url, perceptual_hash,
        first_seen_at, last_seen_at
      ) VALUES (
        repeat('a', 64), $1, $2, 'old-valid', 'Recall City',
        'https://example.invalid/old-valid', $3, '2020-01-01', '2020-01-01'
      )
    `, [OLD_SOURCE, COUNTRY, OLD_VALID]);

    // Populate more rows than the historical newest-N candidate cap. They are
    // deliberately newer and do not share a 00 byte band with TARGET.
    await pool.query(`
      INSERT INTO listing_photo_hashes (
        hash, source, country, source_id, city, photo_url, perceptual_hash,
        first_seen_at, last_seen_at
      )
      SELECT
        repeat(md5('recall-noise-' || i::text), 2),
        $1,
        $2,
        'noise-' || i::text,
        'Recall City',
        'https://example.invalid/noise/' || i::text,
        'ffffffffffffffff',
        NOW(),
        NOW()
      FROM generate_series(1, 1200) AS i
    `, [NOISE_SOURCE, COUNTRY]);

    const newer = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM listing_photo_hashes
      WHERE country = $1 AND last_seen_at > '2020-01-01'::timestamptz
    `, [COUNTRY]);
    assert.ok(Number(newer.rows[0]?.count) > 800, 'fixture must exceed the old newest-N cap');

    // Same indexed candidate predicate used by photo-antifake.js. Static tests
    // separately assert that the production function contains all eight bands
    // and no newest-N LIMIT; this integration test proves the DB semantics and
    // recall property with an actually old row.
    const candidates = await pool.query(`
      SELECT source, source_id, perceptual_hash, last_seen_at
      FROM listing_photo_hashes
      WHERE country = $1
        AND perceptual_hash IS NOT NULL
        AND (
          SUBSTRING(perceptual_hash FROM 1 FOR 2) = SUBSTRING($2::text FROM 1 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 3 FOR 2) = SUBSTRING($2::text FROM 3 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 5 FOR 2) = SUBSTRING($2::text FROM 5 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 7 FOR 2) = SUBSTRING($2::text FROM 7 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 9 FOR 2) = SUBSTRING($2::text FROM 9 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 11 FOR 2) = SUBSTRING($2::text FROM 11 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 13 FOR 2) = SUBSTRING($2::text FROM 13 FOR 2)
          OR SUBSTRING(perceptual_hash FROM 15 FOR 2) = SUBSTRING($2::text FROM 15 FOR 2)
        )
      ORDER BY last_seen_at DESC
    `, [COUNTRY, TARGET]);

    const accepted = candidates.rows.filter((row) =>
      hammingDistanceHex(TARGET, String(row.perceptual_hash).trim()) <= 7,
    );
    assert.ok(accepted.some((row) => row.source === OLD_SOURCE && row.source_id === 'old-valid'));
    assert.equal(hammingDistanceHex(TARGET, OLD_VALID), 7);
  } finally {
    await pool.query('DELETE FROM listing_photo_hashes WHERE source = ANY($1::text[])', [[OLD_SOURCE, NOISE_SOURCE]]);
    await closeDb();
  }
});
