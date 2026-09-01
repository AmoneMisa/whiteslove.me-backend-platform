import {createHash, randomUUID} from 'node:crypto';
import {canonicalCity} from '@whiteslove/parsing-lexicon/geography';
import {COUNTRY_CODES} from './countries.js';
import {pool} from './db.js';
import {getRates} from './fx.js';
import {parseListingFilters} from './listing-routes.js';
import {mobilePushConfigured, sendMobilePush} from './mobile-fcm.js';
import {searchPostgresListings} from './postgres-search-fast.js';
import {checkRate} from './request-rate-limit.js';

const SCHEMA = 'subscriptions';
const MAX_PRESETS_PER_DEVICE = 40;
const SCANNER_ADVISORY_LOCK = 742_102;
const DELIVERY_LEASE_MS = Math.max(
  60_000,
  Math.min(Number(process.env.MOBILE_DELIVERY_LEASE_SECONDS) || 300, 3600) * 1000,
);
const MAX_NOTIFICATIONS_PER_SCAN = Math.max(
  1,
  Math.min(Number(process.env.MOBILE_SUBSCRIPTION_MAX_NOTIFICATIONS_PER_SCAN) || 8, 30),
);
const POLL_MS = Math.max(
  30_000,
  Math.min(Number(process.env.MOBILE_SUBSCRIPTION_POLL_SECONDS) || 60, 3600) * 1000,
);

let scanTimer;
let scanning = false;

function cleanId(value, max = 80) {
  const result = String(value || '').trim();
  if (result.length < 8 || result.length > max || !/^[A-Za-z0-9._:-]+$/.test(result)) return null;
  return result;
}

function cleanLanguage(value) {
  const lang = String(value || 'ru').trim().toLowerCase();
  return /^[a-z]{2}(?:-[a-z]{2})?$/.test(lang) ? lang.slice(0, 8) : 'ru';
}

function cleanPlatform(value) {
  const platform = String(value || 'android').trim().toLowerCase();
  return ['android', 'ios'].includes(platform) ? platform : 'android';
}

function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanId(raw.id);
  if (!id) return null;
  const name = String(raw.name || 'Preset').trim().slice(0, 120) || 'Preset';
  const filters = raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters)
    ? raw.filters
    : {};
  return {id, name, filters};
}

function snapshotQuery(snapshot) {
  const query = {};
  for (const [key, value] of Object.entries(snapshot || {})) {
    if (value == null || value === '') continue;
    if (key === 'countries' || key === 'amenities' || key === 'sort') continue;
    if (key === 'sources' || key === 'customSources') {
      query[key] = Array.isArray(value) ? value.join(',') : String(value);
      continue;
    }
    query[key] = typeof value === 'boolean' ? (value ? 'true' : '') : value;
  }
  for (const amenity of Array.isArray(snapshot?.amenities) ? snapshot.amenities : []) {
    const key = String(amenity || '').trim();
    if (key) query[key] = 'true';
  }
  query.sort = 'newest';
  query.limit = '60';
  query.offset = '0';
  return query;
}

export function mobilePresetSearch(snapshot) {
  const requestedCountries = Array.isArray(snapshot?.countries)
    ? snapshot.countries
    : String(snapshot?.countries || '').split(',');
  const countries = [...new Set(requestedCountries
    .map((value) => String(value).trim().toUpperCase())
    .filter((value) => COUNTRY_CODES.includes(value)))];
  const codes = countries.length ? countries : COUNTRY_CODES;
  const filters = parseListingFilters(snapshotQuery(snapshot));
  if (filters.city) {
    const country = codes.length === 1 ? codes[0] : undefined;
    filters.city = canonicalCity(filters.city, country) || filters.city;
  }
  return {filters, countries: codes};
}

async function syncDevice({deviceId, pushToken, platform, language, enabled, presets}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO ${SCHEMA}.mobile_devices
        (device_id, push_token, platform, language, enabled)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (device_id) DO UPDATE SET
        push_token = EXCLUDED.push_token,
        platform = EXCLUDED.platform,
        language = EXCLUDED.language,
        enabled = EXCLUDED.enabled,
        updated_at = NOW();
    `, [deviceId, pushToken, platform, language, enabled]);

    const presetIds = [];
    for (const preset of presets) {
      presetIds.push(preset.id);
      const result = await client.query(`
        INSERT INTO ${SCHEMA}.mobile_subscriptions
          (device_id, preset_id, name, filters, enabled)
        VALUES ($1, $2, $3, $4::jsonb, TRUE)
        ON CONFLICT (device_id, preset_id) DO UPDATE SET
          name = EXCLUDED.name,
          filters = EXCLUDED.filters,
          enabled = TRUE,
          initialized = CASE
            WHEN ${SCHEMA}.mobile_subscriptions.filters IS DISTINCT FROM EXCLUDED.filters
              OR ${SCHEMA}.mobile_subscriptions.enabled = FALSE
              THEN FALSE
            ELSE ${SCHEMA}.mobile_subscriptions.initialized
          END,
          last_checked_at = CASE
            WHEN ${SCHEMA}.mobile_subscriptions.filters IS DISTINCT FROM EXCLUDED.filters
              OR ${SCHEMA}.mobile_subscriptions.enabled = FALSE
              THEN NULL
            ELSE ${SCHEMA}.mobile_subscriptions.last_checked_at
          END,
          updated_at = NOW()
        RETURNING id, initialized;
      `, [deviceId, preset.id, preset.name, JSON.stringify(preset.filters)]);
      const row = result.rows[0];
      if (row && !row.initialized) {
        await client.query(
          `DELETE FROM ${SCHEMA}.mobile_subscription_seen WHERE subscription_id = $1`,
          [row.id],
        );
      }
    }

    if (presetIds.length) {
      await client.query(`
        DELETE FROM ${SCHEMA}.mobile_subscriptions
        WHERE device_id = $1 AND NOT (preset_id = ANY($2::text[]));
      `, [deviceId, presetIds]);
    } else {
      await client.query(`DELETE FROM ${SCHEMA}.mobile_subscriptions WHERE device_id = $1`, [deviceId]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function registerMobileSubscriptionRoutes(app) {
  app.get('/api/mobile-subscriptions/config', (_req, res) => {
    res.json({pushTransportConfigured: mobilePushConfigured()});
  });

  app.put('/api/mobile-subscriptions', async (req, res) => {
    if (!checkRate(req, res, 'mobile-subscriptions', 750)) return;
    const deviceId = cleanId(req.body?.deviceId);
    if (!deviceId) return res.status(400).json({error: 'Invalid deviceId'});
    const pushToken = String(req.body?.pushToken || '').trim().slice(0, 4096);
    const enabled = req.body?.enabled !== false;
    const platform = cleanPlatform(req.body?.platform);
    const language = cleanLanguage(req.body?.language);
    const rawPresets = Array.isArray(req.body?.presets) ? req.body.presets : [];
    if (rawPresets.length > MAX_PRESETS_PER_DEVICE) {
      return res.status(400).json({error: `At most ${MAX_PRESETS_PER_DEVICE} presets are allowed`});
    }
    const presets = rawPresets.map(normalizePreset).filter(Boolean);
    if (presets.length !== rawPresets.length) {
      return res.status(400).json({error: 'Invalid preset payload'});
    }
    try {
      await syncDevice({deviceId, pushToken, platform, language, enabled, presets});
      return res.json({ok: true, count: presets.length, pushTransportConfigured: mobilePushConfigured()});
    } catch (err) {
      console.error('[mobile-subscriptions] sync failed:', err);
      return res.status(500).json({error: 'Could not save mobile subscriptions'});
    }
  });
}

async function enabledSubscriptions() {
  const result = await pool.query(`
    SELECT s.*, d.push_token, d.language, d.platform
    FROM ${SCHEMA}.mobile_subscriptions s
    JOIN ${SCHEMA}.mobile_devices d ON d.device_id = s.device_id
    WHERE s.enabled = TRUE AND d.enabled = TRUE AND d.push_token <> ''
    ORDER BY s.id ASC;
  `);
  return result.rows;
}

function listingKey(item) {
  const source = String(item?.source || '').toLowerCase();
  const country = String(item?.country || '').toUpperCase();
  const id = String(item?.id || item?.url || '').trim();
  return source && id ? `${source}:${country}:${id}` : null;
}

function deliveryId(deviceId, key) {
  return createHash('sha256')
    .update(`${deviceId}|flats|${key}`)
    .digest('hex')
    .slice(0, 32);
}

async function markSeenKeys(client, subscriptionId, keys) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  if (!unique.length) return 0;
  const result = await client.query(`
    INSERT INTO ${SCHEMA}.mobile_subscription_seen (subscription_id, item_key)
    SELECT $1, item_key
    FROM UNNEST($2::text[]) AS item_key
    ON CONFLICT DO NOTHING;
  `, [subscriptionId, unique]);
  return result.rowCount;
}

async function primeSeen(subscription, items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = items.map(listingKey).filter(Boolean);
    await markSeenKeys(client, subscription.id, keys);
    await client.query(`
      UPDATE ${SCHEMA}.mobile_subscriptions
      SET initialized = TRUE, last_checked_at = NOW()
      WHERE id = $1;
    `, [subscription.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function fetchMatches(subscription) {
  const {filters, countries} = mobilePresetSearch(subscription.filters || {});
  let rates = null;
  try {
    rates = (await getRates()).rates;
  } catch {}
  const result = await searchPostgresListings({filters, countries, rates, searchMatches: null});
  return result.listings || [];
}

async function seenItemKeys(subscriptionId, keys) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  if (!unique.length) return new Set();
  const result = await pool.query(`
    SELECT item_key
    FROM ${SCHEMA}.mobile_subscription_seen
    WHERE subscription_id = $1
      AND item_key = ANY($2::text[]);
  `, [subscriptionId, unique]);
  return new Set(result.rows.map((row) => String(row.item_key)));
}

async function claimDelivery(subscription, key) {
  const token = randomUUID();
  const result = await pool.query(`
    WITH claimed AS (
      INSERT INTO ${SCHEMA}.mobile_deliveries (
        device_id,
        kind,
        item_key,
        first_subscription_id,
        status,
        attempts,
        lock_token,
        locked_until,
        sent_at,
        last_error,
        updated_at
      )
      VALUES (
        $1,
        'flats',
        $2,
        $3,
        'sending',
        1,
        $4::uuid,
        NOW() + ($5::bigint * INTERVAL '1 millisecond'),
        NULL,
        NULL,
        NOW()
      )
      ON CONFLICT (device_id, kind, item_key) DO UPDATE SET
        status = 'sending',
        attempts = ${SCHEMA}.mobile_deliveries.attempts + 1,
        first_subscription_id = COALESCE(${SCHEMA}.mobile_deliveries.first_subscription_id, EXCLUDED.first_subscription_id),
        lock_token = EXCLUDED.lock_token,
        locked_until = EXCLUDED.locked_until,
        last_error = NULL,
        updated_at = NOW()
      WHERE ${SCHEMA}.mobile_deliveries.status = 'failed'
         OR (
           ${SCHEMA}.mobile_deliveries.status = 'sending'
           AND (
             ${SCHEMA}.mobile_deliveries.locked_until IS NULL
             OR ${SCHEMA}.mobile_deliveries.locked_until < NOW()
           )
         )
      RETURNING TRUE AS claimed, status, lock_token
    )
    SELECT claimed, status, lock_token
    FROM claimed
    UNION ALL
    SELECT FALSE AS claimed, delivery.status, NULL::uuid AS lock_token
    FROM ${SCHEMA}.mobile_deliveries delivery
    WHERE delivery.device_id = $1
      AND delivery.kind = 'flats'
      AND delivery.item_key = $2
      AND NOT EXISTS (SELECT 1 FROM claimed)
    LIMIT 1;
  `, [subscription.device_id, key, subscription.id, token, DELIVERY_LEASE_MS]);

  const row = result.rows[0];
  return {
    claimed: row?.claimed === true,
    status: row?.status || null,
    lockToken: row?.lock_token ? String(row.lock_token) : null,
  };
}

async function completeDelivery(subscription, key, lockToken) {
  const result = await pool.query(`
    UPDATE ${SCHEMA}.mobile_deliveries
    SET
      status = 'sent',
      sent_at = NOW(),
      lock_token = NULL,
      locked_until = NULL,
      last_error = NULL,
      updated_at = NOW()
    WHERE device_id = $1
      AND kind = 'flats'
      AND item_key = $2
      AND status = 'sending'
      AND lock_token = $3::uuid;
  `, [subscription.device_id, key, lockToken]);
  return result.rowCount > 0;
}

async function failDelivery(subscription, key, lockToken, error) {
  await pool.query(`
    UPDATE ${SCHEMA}.mobile_deliveries
    SET
      status = 'failed',
      lock_token = NULL,
      locked_until = NULL,
      last_error = $4,
      updated_at = NOW()
    WHERE device_id = $1
      AND kind = 'flats'
      AND item_key = $2
      AND status = 'sending'
      AND lock_token = $3::uuid;
  `, [subscription.device_id, key, lockToken, String(error || 'push failed').slice(0, 4000)]);
}

function notificationText(subscription, item) {
  const price = item?.price != null
    ? `${Math.round(Number(item.price)).toLocaleString('en-US')} ${item.currency || ''}`.trim()
    : null;
  const location = [item?.city, item?.district].filter(Boolean).join(', ');
  const title = String(subscription.language || '').startsWith('ru')
    ? `Новое жильё · ${subscription.name}`
    : `New listing · ${subscription.name}`;
  const body = [price, location, item?.title].filter(Boolean).join(' · ').slice(0, 220)
    || (String(subscription.language || '').startsWith('ru') ? 'Новое объявление по вашему фильтру' : 'A new listing matches your filter');
  return {title, body};
}

async function scanSubscription(subscription) {
  const items = await fetchMatches(subscription);
  if (!subscription.initialized) {
    await primeSeen(subscription, items);
    return 0;
  }

  const itemKeys = items.map(listingKey).filter(Boolean);
  const alreadySeen = await seenItemKeys(subscription.id, itemKeys);
  const seenAfterScan = new Set();
  let sent = 0;

  for (const item of [...items].reverse()) {
    if (sent >= MAX_NOTIFICATIONS_PER_SCAN) break;
    const key = listingKey(item);
    if (!key || alreadySeen.has(key)) continue;

    const claim = await claimDelivery(subscription, key);
    if (!claim.claimed) {
      if (claim.status === 'sent') seenAfterScan.add(key);
      continue;
    }

    const {title, body} = notificationText(subscription, item);
    try {
      await sendMobilePush({
        token: subscription.push_token,
        title,
        body,
        data: {
          type: 'listing',
          publicId: item.publicId ?? '',
          source: item.source ?? '',
          country: item.country ?? '',
          listingId: item.id ?? '',
          presetId: subscription.preset_id,
          deliveryId: deliveryId(subscription.device_id, key),
        },
      });
      const completed = await completeDelivery(subscription, key, claim.lockToken);
      if (completed) {
        seenAfterScan.add(key);
        sent += 1;
      }
    } catch (err) {
      await failDelivery(subscription, key, claim.lockToken, err);
      console.warn(`[mobile-push] ${subscription.device_id}/${key} failed:`, err?.message ?? err);
      const invalidToken = ['NOT_FOUND', 'UNREGISTERED'].includes(String(err?.firebaseStatus || '').toUpperCase())
        || String(err?.message || '').includes('UNREGISTERED');
      if (invalidToken) {
        await pool.query(`
          UPDATE ${SCHEMA}.mobile_devices
          SET enabled = FALSE, updated_at = NOW()
          WHERE device_id = $1;
        `, [subscription.device_id]);
        break;
      }
      throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await markSeenKeys(client, subscription.id, [...seenAfterScan]);
    await client.query(`
      UPDATE ${SCHEMA}.mobile_subscriptions
      SET last_checked_at = NOW()
      WHERE id = $1;
    `, [subscription.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return sent;
}

export async function scanMobileSubscriptions() {
  if (scanning || !mobilePushConfigured()) return;
  scanning = true;
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lockResult = await lockClient.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [SCANNER_ADVISORY_LOCK],
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) return;

    for (const subscription of await enabledSubscriptions()) {
      try {
        await scanSubscription(subscription);
      } catch (err) {
        console.warn(`[mobile-subscriptions] scan #${subscription.id} failed:`, err?.message ?? err);
      }
    }
  } finally {
    if (locked) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [SCANNER_ADVISORY_LOCK]);
      } catch (err) {
        console.warn('[mobile-subscriptions] scanner unlock failed:', err?.message ?? err);
      }
    }
    lockClient.release();
    scanning = false;
  }
}

export function startMobileSubscriptionScanner() {
  if (!mobilePushConfigured()) {
    console.log('[mobile-push] transport disabled; set FIREBASE_SERVICE_ACCOUNT_B64 to send apartment pushes');
    return;
  }
  if (scanTimer) return;
  console.log(`[mobile-push] scanning apartment presets every ${Math.round(POLL_MS / 1000)}s`);
  scanTimer = setInterval(() => void scanMobileSubscriptions(), POLL_MS);
  scanTimer.unref?.();
  void scanMobileSubscriptions();
}

export function stopMobileSubscriptionScanner() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = undefined;
}
