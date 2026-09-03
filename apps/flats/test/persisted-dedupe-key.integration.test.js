import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const {Client} = pg;
const connectionString = process.env.TEST_POSTGRES_URL || '';
const migrationsDir = new URL('../migrations/', import.meta.url);

const md5 = (value) => createHash('md5').update(value).digest('hex');
const cleanText = (value) => String(value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
const cleanPhoto = (value) => {
  let raw = '';
  if (typeof value === 'string') raw = value;
  else if (value && typeof value === 'object') raw = value.link ?? value.url ?? value.src ?? '';
  return String(raw).split('?', 1)[0].replace(/;s=.*$/u, '').toLowerCase();
};
const joined = (...parts) => parts.map((part) => String(part ?? '')).join('|');
const areaText = (value) => value == null ? '' : Number(value).toFixed(1);

function legacyKey(row) {
  const source = String(row.source ?? '').toLowerCase();
  const country = String(row.country ?? '').toUpperCase();
  const title = cleanText(row.title);
  const description = cleanText(row.description);
  const photos = Array.isArray(row.data?.photos) ? row.data.photos : [];
  const photo0 = cleanPhoto(photos[0]);
  const photo1 = cleanPhoto(photos[1]);

  if (source === 'olx' && photo0.length >= 24 && photo1.length >= 24 && photo0 !== photo1) {
    return `olx:photos:${md5(joined(country, photo0, photo1))}`;
  }

  const contentParts = [
    country,
    String(row.city ?? '').toLowerCase(),
    row.deal_type ?? '',
    row.property_type ?? '',
    row.price == null ? '' : String(row.price),
    String(row.currency ?? '').toUpperCase(),
    row.rooms == null ? '' : String(row.rooms),
    areaText(row.area_sqm),
    title,
    description,
  ];

  if (source === 'olx' && description.length >= 120) {
    return `olx:content:${md5(joined(...contentParts))}`;
  }

  const telegramPhotoKey = String(row.data?.photoFingerprintKey ?? '');
  if (source === 'telegram' && telegramPhotoKey.length >= 129) {
    return `telegram:photos:${md5(joined(country, telegramPhotoKey))}`;
  }
  if (source === 'telegram' && description.length >= 40) {
    return `telegram:content:${md5(joined(...contentParts))}`;
  }

  return `${source}:${country}:${row.source_id}`;
}

async function migration(name) {
  return readFile(new URL(name, migrationsDir), 'utf8');
}

test('persisted dedupe key is equivalent to the previous runtime fingerprint', {skip: !connectionString}, async () => {
  const client = new Client({connectionString});
  const schema = `dedupe_migration_test_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    // This test intentionally replays old migrations. Keep that destructive
    // fixture out of public so parallel integration tests never lose the
    // current listings table, generated columns, triggers, or foreign keys.
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(await migration('001_baseline_listings.sql'));
    await client.query(await migration('010_persisted_dedupe_key.sql'));

    const vectors = [
      {
        source: 'olx', country: 'UA', source_id: 'photo-1', title: '  Nice   Flat ', description: 'short',
        property_type: 'flat', deal_type: 'sale', city: 'Kyiv', price: 80000, currency: 'USD', rooms: 2, area_sqm: 42.5,
        data: {photos: ['https://img.example.com/aaaaaaaaaaaa/one.jpg?x=1', {url: 'HTTPS://IMG.EXAMPLE.COM/BBBBBBBBBBBB/two.jpg;s=640x480'}]},
      },
      {
        source: 'olx', country: 'UA', source_id: 'content-1', title: ' Spacious   apartment ',
        description: 'Very long listing description '.repeat(7), property_type: 'flat', deal_type: 'longRent', city: 'Odesa',
        price: 500, currency: 'USD', rooms: 2, area_sqm: 60, data: {photos: []},
      },
      {
        source: 'telegram', country: 'UZ', source_id: 'telegram-photo', title: 'Flat', description: 'tiny',
        property_type: 'flat', deal_type: 'longRent', city: 'Tashkent', price: 700, currency: 'USD', rooms: 3, area_sqm: 75,
        data: {photoFingerprintKey: 'x'.repeat(129)},
      },
      {
        source: 'telegram', country: 'UZ', source_id: 'telegram-content', title: '  Kvartira  ',
        description: 'Long enough Telegram housing description with repeated   spaces and details.',
        property_type: 'flat', deal_type: 'longRent', city: 'Tashkent', price: 600, currency: 'USD', rooms: 2, area_sqm: 55.2,
        data: {},
      },
      {
        source: 'facebook', country: 'RO', source_id: 'fallback-1', title: 'Home', description: 'short',
        property_type: 'house', deal_type: 'sale', city: 'Cluj-Napoca', price: 100000, currency: 'EUR', rooms: 4, area_sqm: 120,
        data: {},
      },
    ];

    for (const row of vectors) {
      await client.query(`
        INSERT INTO listings (
          source, country, source_id, title, description, property_type, deal_type,
          city, price, currency, rooms, area_sqm, data, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,NOW())
      `, [
        row.source, row.country, row.source_id, row.title, row.description, row.property_type, row.deal_type,
        row.city, row.price, row.currency, row.rooms, row.area_sqm, JSON.stringify(row.data),
      ]);
    }

    const result = await client.query('SELECT source_id, dedupe_key FROM listings ORDER BY id');
    assert.deepEqual(result.rows.map((row) => row.dedupe_key), vectors.map(legacyKey));

    const before = result.rows.find((row) => row.source_id === 'telegram-content').dedupe_key;
    vectors[3].description += ' changed';
    await client.query('UPDATE listings SET description = $1 WHERE source_id = $2', [vectors[3].description, vectors[3].source_id]);
    const after = await client.query('SELECT dedupe_key FROM listings WHERE source_id = $1', [vectors[3].source_id]);
    assert.equal(after.rows[0].dedupe_key, legacyKey(vectors[3]));
    assert.notEqual(after.rows[0].dedupe_key, before, 'stored generated key must refresh when fingerprint inputs change');
  } finally {
    await client.query('RESET search_path').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

test('listing reads use persisted dedupe keys while stats preserve exact visibility semantics', async () => {
  const search = await readFile(new URL('../src/infrastructure/search/postgres-search-core.js', import.meta.url), 'utf8');
  const migrationSql = await migration('010_persisted_dedupe_key.sql');

  assert.match(search, /dedupeEnabled \? 'l\.dedupe_key'/);
  assert.match(search, /PARTITION BY filtered\.dedupe_key/);
  assert.match(search, /COUNT\(\*\)::int AS total/);
  assert.match(search, /\(SELECT total FROM totals\) AS total/);
  assert.match(search, /duplicatesRejected/);
  assert.doesNotMatch(search, /function listingDedupeSql/);
  assert.doesNotMatch(search, /function olxPhotoSql/);

  assert.match(migrationSql, /GENERATED ALWAYS AS/);
  assert.match(migrationSql, /compute_listing_dedupe_key/);
  assert.match(migrationSql, /listings_active_dedupe_created_idx/);
  assert.match(migrationSql, /listings_active_country_dedupe_created_idx/);
});