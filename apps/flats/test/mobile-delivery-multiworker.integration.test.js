import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {pool} from '../src/db.js';
import {assertDatabaseReady} from '../src/db-ready.js';

const enabled = Boolean(process.env.TEST_POSTGRES_URL);
const DEVICE_ID = 'perf-mobile-worker-device';
const PRESET_ID = 'perf-mobile-worker-preset';
const SOURCE = 'olx';
const COUNTRY = 'UA';
const SOURCE_ID = 'perf-mobile-worker-listing';
const CITY = 'PerformanceTestCity';
const PRICE = 424242;
const WORKER_COUNT = 4;
const SEND_MARKER = 'MOCK_FCM_SEND:';

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const mobileModuleUrl = new URL('../src/mobile-subscriptions.js', import.meta.url).href;

function fakeServiceAccount() {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  return Buffer.from(JSON.stringify({
    client_email: 'flat-finder-ci@example.invalid',
    private_key: privateKey.export({type: 'pkcs8', format: 'pem'}),
    project_id: 'flat-finder-ci',
  }), 'utf8').toString('base64');
}

const workerScript = String.raw`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('open.er-api.com')) {
    return new Response(JSON.stringify({
      result: 'success',
      base_code: 'USD',
      rates: {USD: 1, EUR: 0.92, RON: 4.57, UAH: 41.5, KZT: 470, UZS: 12600},
    }), {status: 200, headers: {'content-type': 'application/json'}});
  }
  if (url.includes('oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({access_token: 'ci-token', expires_in: 3600}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }
  if (url.includes('fcm.googleapis.com/')) {
    const payload = JSON.parse(String(init.body || '{}'));
    console.log('${SEND_MARKER}' + JSON.stringify(payload));
    // Hold the scanner advisory lock long enough for sibling processes to
    // contend for it instead of merely running one after another.
    await sleep(400);
    return new Response(JSON.stringify({name: 'projects/flat-finder-ci/messages/1'}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }
  throw new Error('unexpected mocked fetch: ' + url);
};

try {
  const {scanMobileSubscriptions} = await import(process.env.MOBILE_SUBSCRIPTIONS_MODULE_URL);
  await scanMobileSubscriptions();
  process.exit(0);
} catch (error) {
  console.error(error?.stack || error);
  process.exit(1);
}
`;

function runWorker(serviceAccount) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
      cwd: backendDir,
      env: {
        ...process.env,
        FIREBASE_SERVICE_ACCOUNT_B64: serviceAccount,
        MOBILE_SUBSCRIPTIONS_MODULE_URL: mobileModuleUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`mobile scanner worker exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({stdout, stderr});
    });
  });
}

async function seedFixture() {
  await pool.query('DELETE FROM subscriptions.mobile_devices WHERE device_id = $1', [DEVICE_ID]);
  await pool.query('DELETE FROM listings WHERE source = $1 AND country = $2 AND source_id = $3', [SOURCE, COUNTRY, SOURCE_ID]);

  const now = new Date().toISOString();
  const data = {
    id: SOURCE_ID,
    source: SOURCE,
    country: COUNTRY,
    title: 'Multi-worker mobile delivery fixture',
    description: 'Synthetic listing used to exercise one transport send across scanner replicas.',
    propertyType: 'flat',
    dealType: 'longRent',
    city: CITY,
    price: PRICE,
    currency: 'USD',
    rooms: 2,
    areaSqm: 55,
    byAgency: false,
    commercial: false,
    listingKind: 'propertyOffer',
    listingStatus: 'active',
    createdAt: now,
  };

  await pool.query(`
    INSERT INTO listings (
      source, country, source_id, title, description, property_type, deal_type,
      city, price, currency, rooms, area_sqm, by_agency, created_at, active, data
    ) VALUES (
      $1, $2, $3, $4, $5, 'flat', 'longRent',
      $6, $7, 'USD', 2, 55, FALSE, $8::timestamptz, TRUE, $9::jsonb
    );
  `, [
    SOURCE,
    COUNTRY,
    SOURCE_ID,
    data.title,
    data.description,
    CITY,
    PRICE,
    now,
    JSON.stringify(data),
  ]);

  await pool.query(`
    INSERT INTO subscriptions.mobile_devices (
      device_id, push_token, platform, language, enabled
    ) VALUES ($1, 'ci-push-token', 'android', 'en', TRUE);
  `, [DEVICE_ID]);

  await pool.query(`
    INSERT INTO subscriptions.mobile_subscriptions (
      device_id, preset_id, name, filters, enabled, initialized
    ) VALUES (
      $1,
      $2,
      'Multi-worker CI',
      $3::jsonb,
      TRUE,
      TRUE
    );
  `, [DEVICE_ID, PRESET_ID, JSON.stringify({
    countries: [COUNTRY],
    sources: [SOURCE],
    city: CITY,
    dealType: 'longRent',
    priceMin: PRICE,
    priceMax: PRICE,
    priceCurrency: 'USD',
  })]);
}

async function cleanupFixture() {
  await pool.query('DELETE FROM subscriptions.mobile_devices WHERE device_id = $1', [DEVICE_ID]);
  await pool.query('DELETE FROM listings WHERE source = $1 AND country = $2 AND source_id = $3', [SOURCE, COUNTRY, SOURCE_ID]);
}

test('concurrent scanner processes emit one FCM transport send for one delivery', {skip: !enabled}, async () => {
  await assertDatabaseReady();
  await seedFixture();
  const serviceAccount = fakeServiceAccount();

  try {
    const workers = await Promise.all(
      Array.from({length: WORKER_COUNT}, () => runWorker(serviceAccount)),
    );
    const sends = workers.flatMap(({stdout}) => stdout
      .split('\n')
      .filter((line) => line.startsWith(SEND_MARKER))
      .map((line) => JSON.parse(line.slice(SEND_MARKER.length))));

    assert.equal(sends.length, 1, 'only one scanner process may cross the FCM transport boundary');
    const message = sends[0]?.message;
    assert.equal(message?.token, 'ci-push-token');
    assert.equal(message?.data?.type, 'listing');
    assert.equal(message?.data?.listingId, SOURCE_ID);
    assert.equal(message?.data?.presetId, PRESET_ID);
    assert.match(message?.data?.deliveryId || '', /^[a-f0-9]{32}$/);

    const delivery = await pool.query(`
      SELECT status, attempts, sent_at, lock_token, locked_until
      FROM subscriptions.mobile_deliveries
      WHERE device_id = $1
        AND kind = 'flats'
        AND item_key = $2;
    `, [DEVICE_ID, `${SOURCE}:${COUNTRY}:${SOURCE_ID}`]);
    assert.equal(delivery.rows.length, 1);
    assert.equal(delivery.rows[0].status, 'sent');
    assert.equal(delivery.rows[0].attempts, 1);
    assert.ok(delivery.rows[0].sent_at);
    assert.equal(delivery.rows[0].lock_token, null);
    assert.equal(delivery.rows[0].locked_until, null);

    const seen = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM subscriptions.mobile_subscription_seen seen
      JOIN subscriptions.mobile_subscriptions subscription
        ON subscription.id = seen.subscription_id
      WHERE subscription.device_id = $1
        AND subscription.preset_id = $2
        AND seen.item_key = $3;
    `, [DEVICE_ID, PRESET_ID, `${SOURCE}:${COUNTRY}:${SOURCE_ID}`]);
    assert.equal(seen.rows[0].count, 1);

    // A later scan after the advisory lock is released must also stay silent:
    // durable delivery/seen state, not only timing, prevents another push.
    const after = await runWorker(serviceAccount);
    assert.equal(
      after.stdout.split('\n').filter((line) => line.startsWith(SEND_MARKER)).length,
      0,
    );
  } finally {
    await cleanupFixture();
    await pool.end();
  }
});
