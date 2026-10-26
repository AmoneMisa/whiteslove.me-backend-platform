import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1' || Boolean(process.env.TEST_PGLITE_MODULE);

test('weak photo repair splits unsupported pairs, preserves stronger evidence and rejects stale cluster ids', {skip: !enabled}, async () => {
  let db, admin, database;
  if (process.env.TEST_PGLITE_MODULE) {
    const {PGlite} = await import(process.env.TEST_PGLITE_MODULE);
    db = new PGlite();
  } else {
    const config = process.env.TEST_POSTGRES_URL ? {connectionString: process.env.TEST_POSTGRES_URL} : {
      host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT) || 5432,
      database: process.env.POSTGRES_DB || 'flatfinder', user: process.env.POSTGRES_USER || 'flatfinder',
      password: process.env.POSTGRES_PASSWORD,
    };
    database = `weak_photo_repair_${process.pid}_${randomBytes(5).toString('hex')}`;
    admin = new pg.Client(config); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const connection = {...config, database};
    if (config.connectionString) {
      const url = new URL(config.connectionString); url.pathname = `/${database}`;
      connection.connectionString = url.toString();
    }
    const client = new pg.Client(connection); await client.connect();
    db = {query: (...args) => client.query(...args), exec: sql => client.query(sql), close: () => client.end()};
  }
  const run = async name => db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const scalar = async sql => (await db.query(sql)).rows[0].n;
  try {
    await db.exec(`CREATE SCHEMA platform;
      CREATE TABLE listings(id BIGSERIAL PRIMARY KEY,source TEXT,country TEXT,source_id TEXT,title TEXT,description TEXT,
        property_type TEXT,deal_type TEXT,city TEXT,price DOUBLE PRECISION,currency TEXT,rooms INT,area_sqm DOUBLE PRECISION,
        created_at TIMESTAMPTZ,active BOOLEAN DEFAULT TRUE,data JSONB DEFAULT '{}');
      CREATE TABLE listing_public_feed_members(id BIGINT);`);
    await run('010_persisted_dedupe_key.sql');
    await run('020_property_identity_unification.sql');
    await run('052_property_clusters_and_lineage.sql');
    const weak = (partner, extra = {}) => ({matchedSource: 'olx', matchedCountry: 'UZ', matchedListingId: partner,
      matchedPhotoCount: 1, exactPhotoCount: 0, perceptualPhotoCount: 1,
      relation: {score: 95, propertyFactsConsistent: false, locationConflict: {level: 'very_high'}}, ...extra});
    const seed = async (cluster, evidence, size = 2) => {
      for (let i = 0; i < size; i++) {
        const sourceId = `${cluster}-${i}`;
        const data = {antiFake: {status: 'completed', fingerprint: 'old', risk: 'very_high',
          cloneMatches: evidence(i, `${cluster}-${1 - i}`)}, duplicatePhotoRisk: 'very_high'};
        await db.query(`INSERT INTO listings(source,country,source_id,data) VALUES('olx','UZ',$1,$2)`, [sourceId, JSON.stringify(data)]);
        await db.query(`INSERT INTO listing_property_clusters(source,country,source_id,cluster_id) VALUES('olx','UZ',$1,$2)`, [sourceId, cluster]);
      }
      await db.query('INSERT INTO platform.property_clusters(cluster_id,member_count) VALUES($1,$2)', [cluster, size]);
    };
    await seed('bad', (i, partner) => i === 0 ? [weak(partner)] : []);
    await seed('exact', (i, partner) => [weak(partner, {exactPhotoCount: 2, matchedPhotoCount: 2})]);
    await seed('multiple', (i, partner) => [weak(partner, {perceptualPhotoCount: 2, matchedPhotoCount: 2})]);
    await seed('unknown', () => []);
    await seed('reverse-support', (i, partner) => [weak(partner, i ? {exactPhotoCount: 2} : {})]);
    await seed('larger', (i, partner) => [weak(partner)], 3);
    await db.exec(`INSERT INTO platform.listing_lineage(from_source,from_country,from_source_id,to_source,to_country,to_source_id,relation)
      VALUES('olx','UZ','bad-0','olx','UZ','bad-1','likely_derived');`);
    assert.equal(await scalar(`SELECT count(DISTINCT dedupe_key)::int n FROM listings WHERE source_id LIKE 'bad-%'`), 1);
    await db.exec('BEGIN'); await run('064_unlink_weak_photo_pairs.sql'); await db.exec('COMMIT');
    assert.equal(await scalar(`SELECT count(*)::int n FROM listing_property_clusters WHERE cluster_id = 'bad'`), 0);
    assert.equal(await scalar(`SELECT count(DISTINCT dedupe_key)::int n FROM listings WHERE source_id LIKE 'bad-%'`), 2);
    assert.equal(await scalar('SELECT count(*)::int n FROM platform.listing_lineage'), 0);
    assert.equal(await scalar('SELECT count(*)::int n FROM platform.property_cluster_repairs'), 1);
    assert.equal(await scalar(`SELECT count(*)::int n FROM listing_property_clusters`), 11);
    assert.equal(await scalar(`SELECT count(*)::int n FROM listings WHERE source_id LIKE 'bad-%' AND data->'antiFake'->>'status' = 'pending'`), 2);
    // A queued/cache payload cannot restore the retired identity or risk label.
    await db.exec(`UPDATE listings SET data = data || '{"propertyClusterId":"bad","duplicatePhotoRisk":"very_high","antiFake":{"status":"completed","risk":"very_high","fingerprint":"stale"}}'
      WHERE source_id = 'bad-0';`);
    const repaired = (await db.query(`SELECT data FROM listings WHERE source_id = 'bad-0'`)).rows[0].data;
    assert.equal(repaired.propertyClusterId, undefined);
    assert.equal(repaired.antiFake.status, 'pending');
    assert.equal(repaired.duplicatePhotoRisk, 'none');
    await db.exec('BEGIN'); await run('064_unlink_weak_photo_pairs.sql'); await db.exec('COMMIT');
    assert.equal(await scalar('SELECT count(*)::int n FROM platform.property_cluster_repairs'), 1);
  } finally {
    await db?.close();
    if (admin) {await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end();}
  }
});
