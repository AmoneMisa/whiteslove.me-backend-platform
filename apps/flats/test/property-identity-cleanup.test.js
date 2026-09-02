import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('photo anti-fake uses the shared database pool and never mutates schema at runtime', async () => {
  const source = await readFile(new URL('../src/listing/photo-antifake.js', import.meta.url), 'utf8');

  assert.match(source, /import \{pool\} from '\.\.\/infrastructure\/database\/pool\.js';/);
  assert.doesNotMatch(source, /from 'pg'/);
  assert.doesNotMatch(source, /\bensureSchema\b/);
  assert.doesNotMatch(source, /CREATE\s+TABLE/i);
  assert.doesNotMatch(source, /ALTER\s+TABLE/i);
  assert.doesNotMatch(source, /CREATE\s+INDEX/i);
});

test('property identity schema and public dedupe are owned by migration 020', async () => {
  const sql = await readFile(new URL('../migrations/020_property_identity_unification.sql', import.meta.url), 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS listing_photo_hashes/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS listing_property_clusters/);
  assert.match(sql, /sync_property_cluster_to_listing/);
  assert.match(sql, /listings_apply_property_cluster_id/);
  assert.match(sql, /propertyClusterId/);
  assert.match(sql, /THEN 'cluster:' \|\| property_cluster_id/);
  assert.doesNotMatch(sql, /cross:photos:/);
});
