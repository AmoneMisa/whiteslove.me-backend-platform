// HTTP surface for saving a device's mobile presets. Search matching lives in
// mobile-preset-search.js; delivery scanning lives in mobile-subscription-scanner.js.
import {pool} from '../infrastructure/database/pool.js';
import {mobilePushConfigured} from './mobile-fcm.js';
import {checkRate} from '../support/request-rate-limit.js';

const SCHEMA = 'subscriptions';
const MAX_PRESETS_PER_DEVICE = 40;

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
