import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const {Client} = pg;
const connectionString = process.env.TEST_POSTGRES_URL || '';
const migrationsDir = new URL('../migrations/', import.meta.url);

async function migration(name) {
  return readFile(new URL(name, migrationsDir), 'utf8');
}

async function insertListing(client, row) {
  await client.query(`
    INSERT INTO listings (
      source, country, source_id, title, description, property_type, deal_type,
      city, price, currency, rooms, area_sqm, data, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,NOW())
  `, [
    row.source,
    row.country,
    row.source_id,
    row.title,
    row.description,
    row.property_type,
    row.deal_type,
    row.city,
    row.price,
    row.currency,
    row.rooms,
    row.area_sqm,
    JSON.stringify(row.data || {}),
  ]);
}

async function bootstrap(client) {
  // This test intentionally replays the historical identity migrations. The
  // fixture must live outside public because Node's test runner executes files
  // concurrently and a destructive replay would otherwise remove later
  // generated columns, relation triggers and indexes from sibling tests.
  await client.query(await migration('001_baseline_listings.sql'));
  await client.query(await migration('010_persisted_dedupe_key.sql'));
  await client.query(await migration('014_public_feed_members.sql'));
  await client.query(await migration('019_cross_source_dedupe.sql'));
  await client.query(await migration('020_property_identity_unification.sql'));
}

test('property clusters are the authoritative strong cross-source identity', {skip: !connectionString}, async () => {
  const client = new Client({connectionString});
  const schema = `cross_source_dedupe_test_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await bootstrap(client);

    await insertListing(client, {
      source: 'olx', country: 'UA', source_id: 'olx-photo', title: 'Квартира у моря', description: 'OLX copy',
      property_type: 'flat', deal_type: 'longRent', city: 'Odesa', price: 600, currency: 'USD', rooms: 2, area_sqm: 55,
      data: {},
    });
    await insertListing(client, {
      source: 'custom', country: 'UA', source_id: 'agency-photo', title: 'Двухкомнатная аренда', description: 'Agency copy with different text',
      property_type: 'flat', deal_type: 'longRent', city: 'Odesa', price: 650, currency: 'USD', rooms: 2, area_sqm: 55,
      data: {},
    });

    const beforeCluster = await client.query(`
      SELECT source_id, dedupe_key FROM listings
      WHERE source_id IN ('olx-photo', 'agency-photo')
      ORDER BY source_id
    `);
    assert.notEqual(beforeCluster.rows[0].dedupe_key, beforeCluster.rows[1].dedupe_key,
      'unproven photo identity must stay separate before anti-fake clustering');

    for (const [source, sourceId] of [['olx', 'olx-photo'], ['custom', 'agency-photo']]) {
      await client.query(`
        INSERT INTO listing_property_clusters(source, country, source_id, cluster_id)
        VALUES ($1, 'UA', $2, 'property:test-shared-home')
      `, [source, sourceId]);
    }

    const clustered = await client.query(`
      SELECT source_id, data->>'propertyClusterId' AS cluster_id, dedupe_key
      FROM listings
      WHERE source_id IN ('olx-photo', 'agency-photo')
      ORDER BY source_id
    `);
    assert.equal(clustered.rows.length, 2);
    assert.equal(clustered.rows[0].cluster_id, 'property:test-shared-home');
    assert.equal(clustered.rows[1].cluster_id, 'property:test-shared-home');
    assert.equal(clustered.rows[0].dedupe_key, 'cluster:property:test-shared-home');
    assert.equal(clustered.rows[0].dedupe_key, clustered.rows[1].dedupe_key);

    const sharedContact = {phone: '+380 95 123 45 67'};
    await insertListing(client, {
      source: 'telegram', country: 'UA', source_id: 'tg-contact', title: 'Оренда квартири', description: 'короткий текст',
      property_type: 'flat', deal_type: 'longRent', city: 'Kyiv', price: 22000, currency: 'UAH', rooms: 2, area_sqm: 61.2,
      data: {contact: sharedContact, address: 'вул. Велика Васильківська, 10', floor: 5},
    });
    await insertListing(client, {
      source: 'facebook', country: 'UA', source_id: 'fb-contact', title: 'Квартира від власника', description: 'інший короткий текст',
      property_type: 'flat', deal_type: 'longRent', city: 'Kyiv', price: 23500, currency: 'UAH', rooms: 2, area_sqm: 61.2,
      data: {contact: sharedContact, address: 'ВУЛ.  Велика Васильківська, 10', floor: 5},
    });

    const contactRows = await client.query(`
      SELECT source_id, dedupe_key FROM listings
      WHERE source_id IN ('tg-contact', 'fb-contact')
      ORDER BY source_id
    `);
    assert.equal(contactRows.rows[0].dedupe_key, contactRows.rows[1].dedupe_key);
    assert.match(contactRows.rows[0].dedupe_key, /^cross:contact-address:/);

    const copiedDescription = 'Простора квартира після ремонту з меблями та технікою. '
      + 'Поруч метро, магазини та парк. Власник просить писати або телефонувати. '.repeat(2);
    for (const [source, id] of [['threads', 'content-threads'], ['custom', 'content-agency']]) {
      await insertListing(client, {
        source, country: 'UA', source_id: id, title: 'Простора двокімнатна квартира в центрі', description: copiedDescription,
        property_type: 'flat', deal_type: 'longRent', city: 'Kyiv', price: 30000, currency: 'UAH', rooms: 2, area_sqm: 64,
        data: {},
      });
    }
    const contentRows = await client.query(`
      SELECT source_id, dedupe_key FROM listings
      WHERE source_id IN ('content-threads', 'content-agency')
      ORDER BY source_id
    `);
    assert.equal(contentRows.rows[0].dedupe_key, contentRows.rows[1].dedupe_key);
    assert.match(contentRows.rows[0].dedupe_key, /^cross:content:/);

    await insertListing(client, {
      source: 'telegram', country: 'UA', source_id: 'agency-flat-a', title: 'Квартира А', description: 'short A',
      property_type: 'flat', deal_type: 'longRent', city: 'Kyiv', price: 20000, currency: 'UAH', rooms: 2, area_sqm: 50,
      data: {contact: sharedContact, address: 'вул. Хрещатик, 1', floor: 3},
    });
    await insertListing(client, {
      source: 'facebook', country: 'UA', source_id: 'agency-flat-b', title: 'Квартира Б', description: 'short B',
      property_type: 'flat', deal_type: 'longRent', city: 'Kyiv', price: 20000, currency: 'UAH', rooms: 2, area_sqm: 50,
      data: {contact: sharedContact, address: 'вул. Хрещатик, 99', floor: 3},
    });
    const negative = await client.query(`
      SELECT source_id, dedupe_key FROM listings
      WHERE source_id IN ('agency-flat-a', 'agency-flat-b')
      ORDER BY source_id
    `);
    assert.notEqual(negative.rows[0].dedupe_key, negative.rows[1].dedupe_key,
      'a shared agency phone must not merge different addresses');
  } finally {
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

test('property identity stays on the persisted indexed read path', async () => {
  const sql = await migration('020_property_identity_unification.sql');
  const search = await readFile(new URL('../src/infrastructure/search/postgres-search-core.js', import.meta.url), 'utf8');
  const fastSearch = await readFile(new URL('../src/infrastructure/search/postgres-search-fast-core.js', import.meta.url), 'utf8');

  assert.match(sql, /propertyClusterId/);
  assert.match(sql, /THEN 'cluster:' \|\| property_cluster_id/);
  assert.match(sql, /cross:contact-address:/);
  assert.match(sql, /cross:content:/);
  assert.doesNotMatch(sql, /cross:photos:/);
  assert.match(search, /PARTITION BY filtered\.dedupe_key/);
  assert.match(fastSearch, /DISTINCT ON \(m\.dedupe_key\)/);
  assert.doesNotMatch(search, /listing_property_clusters/);
  assert.doesNotMatch(fastSearch, /listing_property_clusters/);
});
