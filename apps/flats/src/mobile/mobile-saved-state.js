import {createHash, timingSafeEqual} from 'node:crypto';

import {pool} from '../infrastructure/database/pool.js';
import {checkRate} from '../support/request-rate-limit.js';

const SCHEMA = 'user_data';
const FAVORITES_ID = 'favorites';
const MAX_FAVORITES = 1000;
const MAX_SORTED_COLLECTIONS = 100;
const MAX_SORTED_ITEMS = 5000;
const MAX_PRESETS = 100;
const DEVICE_HEADER = 'x-flat-finder-device-id';
const SECRET_HEADER = 'x-flat-finder-device-secret';

export function cleanSavedStateId(value, {max = 80, min = 8} = {}) {
  const result = String(value || '').trim();
  if (result.length < min || result.length > max) return null;
  return /^[A-Za-z0-9._:-]+$/.test(result) ? result : null;
}

export function cleanInstallationSecret(value) {
  const result = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(result) ? result : null;
}

export function installationSecretHash(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function cleanItemKey(value) {
  const result = String(value || '').trim();
  if (!result || result.length > 320 || /[\u0000-\u001f\u007f]/.test(result)) return null;
  return result;
}

function cleanTitle(value, fallback = '') {
  return String(value ?? fallback).trim().slice(0, 160);
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function badRequest(message) {
  return Object.assign(new Error(message), {statusCode: 400});
}

function unauthorized() {
  return Object.assign(new Error('Invalid installation credentials'), {statusCode: 401});
}

function credentialsFromRequest(req) {
  const deviceId = cleanSavedStateId(req.get(DEVICE_HEADER));
  const secret = cleanInstallationSecret(req.get(SECRET_HEADER));
  return deviceId && secret ? {deviceId, secret} : null;
}

function hashesEqual(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(String(a || '')) || !/^[a-f0-9]{64}$/i.test(String(b || ''))) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function normalizePreset(raw) {
  const value = cleanObject(raw);
  if (!value) return null;
  const id = cleanSavedStateId(value.id);
  const filters = cleanObject(value.filters);
  if (!id || !filters) return null;
  return {
    id,
    name: cleanTitle(value.name, 'Preset') || 'Preset',
    filters,
    enabled: value.enabled !== false,
    notificationsEnabled: value.notificationsEnabled === true,
  };
}

function normalizeItem(raw) {
  const item = cleanObject(raw);
  if (!item) return null;
  const key = cleanItemKey(item.key ?? item.itemKey);
  const listing = cleanObject(item.listing ?? item.payload);
  return key && listing ? {key, listing} : null;
}

function normalizeSortedCollection(raw) {
  const value = cleanObject(raw);
  if (!value) return null;
  const id = cleanSavedStateId(value.id);
  if (!id || id === FAVORITES_ID) return null;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems.map(normalizeItem).filter(Boolean);
  if (items.length !== rawItems.length) return null;
  return {
    id,
    title: cleanTitle(value.title),
    isPreset: value.isPreset === true,
    presetName: value.presetName == null ? null : cleanTitle(value.presetName),
    items,
  };
}

async function ensureInstallation(client, {deviceId, secret}) {
  const secretHash = installationSecretHash(secret);
  await client.query(`
    INSERT INTO ${SCHEMA}.installations(device_id, sync_secret_hash)
    VALUES ($1, $2)
    ON CONFLICT (device_id) DO NOTHING
  `, [deviceId, secretHash]);

  const result = await client.query(`
    SELECT sync_secret_hash
    FROM ${SCHEMA}.installations
    WHERE device_id = $1
  `, [deviceId]);
  const stored = result.rows[0]?.sync_secret_hash;
  if (!hashesEqual(stored, secretHash)) throw unauthorized();

  await client.query(`
    UPDATE ${SCHEMA}.installations
    SET updated_at = NOW()
    WHERE device_id = $1
  `, [deviceId]);
}

async function savedStateSnapshot(credentials) {
  const {deviceId} = credentials;
  const client = await pool.connect();
  try {
    await ensureInstallation(client, credentials);
    const collectionsResult = await client.query(`
      SELECT collection_id, kind, title, is_preset, preset_name
      FROM ${SCHEMA}.saved_collections
      WHERE device_id = $1
      ORDER BY updated_at DESC, collection_id
    `, [deviceId]);
    const itemsResult = await client.query(`
      SELECT collection_id, item_key, payload
      FROM ${SCHEMA}.saved_items
      WHERE device_id = $1
      ORDER BY updated_at DESC, item_key
    `, [deviceId]);
    const presetsResult = await client.query(`
      SELECT preset_id, name, filters, enabled, notifications_enabled
      FROM ${SCHEMA}.saved_presets
      WHERE device_id = $1
      ORDER BY updated_at DESC, preset_id
    `, [deviceId]);

    const byCollection = new Map();
    for (const row of collectionsResult.rows) {
      byCollection.set(row.collection_id, {
        id: row.collection_id,
        kind: row.kind,
        title: row.title,
        isPreset: row.is_preset,
        presetName: row.preset_name,
        items: [],
      });
    }
    for (const row of itemsResult.rows) {
      const collection = byCollection.get(row.collection_id);
      if (collection) collection.items.push({key: row.item_key, listing: row.payload});
    }

    const favoriteCollection = byCollection.get(FAVORITES_ID);
    const sorted = [...byCollection.values()]
      .filter((collection) => collection.kind === 'sorted')
      .map(({kind: _kind, ...collection}) => collection);

    return {
      favorites: favoriteCollection?.items ?? [],
      sorted,
      presets: presetsResult.rows.map((row) => ({
        id: row.preset_id,
        name: row.name,
        filters: row.filters,
        enabled: row.enabled,
        notificationsEnabled: row.notifications_enabled,
      })),
    };
  } finally {
    client.release();
  }
}

async function assertImportCapacity(client, deviceId) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int
       FROM ${SCHEMA}.saved_items
       WHERE device_id = $1 AND collection_id = $2) AS favorites,
      (SELECT COUNT(*)::int
       FROM ${SCHEMA}.saved_collections
       WHERE device_id = $1 AND kind = 'sorted') AS sorted_collections,
      (SELECT COUNT(*)::int
       FROM ${SCHEMA}.saved_items i
       JOIN ${SCHEMA}.saved_collections c
         ON c.device_id = i.device_id AND c.collection_id = i.collection_id
       WHERE i.device_id = $1 AND c.kind = 'sorted') AS sorted_items,
      (SELECT COUNT(*)::int
       FROM ${SCHEMA}.saved_presets
       WHERE device_id = $1) AS presets
  `, [deviceId, FAVORITES_ID]);
  const counts = result.rows[0] || {};
  if (counts.favorites > MAX_FAVORITES ||
      counts.sorted_collections > MAX_SORTED_COLLECTIONS ||
      counts.sorted_items > MAX_SORTED_ITEMS ||
      counts.presets > MAX_PRESETS) {
    throw badRequest('saved state exceeds account limits');
  }
}

async function importLegacyState(credentials, body) {
  const {deviceId} = credentials;
  const rawFavorites = Array.isArray(body.favorites) ? body.favorites : [];
  const rawSorted = Array.isArray(body.sorted) ? body.sorted : [];
  const rawPresets = Array.isArray(body.presets) ? body.presets : [];
  if (rawFavorites.length > MAX_FAVORITES ||
      rawSorted.length > MAX_SORTED_COLLECTIONS ||
      rawPresets.length > MAX_PRESETS) {
    throw badRequest('saved state exceeds import limits');
  }

  const favorites = rawFavorites.map(normalizeItem).filter(Boolean);
  const normalizedSorted = rawSorted.map(normalizeSortedCollection).filter(Boolean);
  const presets = rawPresets.map(normalizePreset).filter(Boolean);
  if (favorites.length !== rawFavorites.length ||
      normalizedSorted.length !== rawSorted.length ||
      presets.length !== rawPresets.length) {
    throw badRequest('invalid saved state import payload');
  }

  const seenSortedKeys = new Set();
  const sorted = normalizedSorted.map((collection) => ({
    ...collection,
    items: collection.items.filter((item) => {
      if (seenSortedKeys.has(item.key)) return false;
      seenSortedKeys.add(item.key);
      return true;
    }),
  })).filter((collection) => collection.items.length > 0);
  const sortedItems = sorted.reduce((count, collection) => count + collection.items.length, 0);
  if (sortedItems > MAX_SORTED_ITEMS) throw badRequest('too many sorted items');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureInstallation(client, credentials);

    if (favorites.length) {
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_collections(device_id, collection_id, kind, title)
        VALUES ($1, $2, 'favorites', 'Favorites')
        ON CONFLICT (device_id, collection_id) DO NOTHING
      `, [deviceId, FAVORITES_ID]);
      for (const item of favorites) {
        await client.query(`
          INSERT INTO ${SCHEMA}.saved_items(device_id, collection_id, item_key, payload)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (device_id, collection_id, item_key) DO NOTHING
        `, [deviceId, FAVORITES_ID, item.key, JSON.stringify(item.listing)]);
      }
    }

    for (const collection of sorted) {
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_collections
          (device_id, collection_id, kind, title, is_preset, preset_name)
        VALUES ($1, $2, 'sorted', $3, $4, $5)
        ON CONFLICT (device_id, collection_id) DO NOTHING
      `, [deviceId, collection.id, collection.title, collection.isPreset, collection.presetName]);
      for (const item of collection.items) {
        await client.query(`
          INSERT INTO ${SCHEMA}.saved_items(device_id, collection_id, item_key, payload)
          SELECT $1, $2, $3, $4::jsonb
          WHERE NOT EXISTS (
            SELECT 1
            FROM ${SCHEMA}.saved_items i
            JOIN ${SCHEMA}.saved_collections c
              ON c.device_id = i.device_id AND c.collection_id = i.collection_id
            WHERE i.device_id = $1 AND i.item_key = $3 AND c.kind = 'sorted'
          )
          ON CONFLICT (device_id, collection_id, item_key) DO NOTHING
        `, [deviceId, collection.id, item.key, JSON.stringify(item.listing)]);
      }
    }

    for (const preset of presets) {
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_presets
          (device_id, preset_id, name, filters, enabled, notifications_enabled)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (device_id, preset_id) DO NOTHING
      `, [deviceId, preset.id, preset.name, JSON.stringify(preset.filters), preset.enabled, preset.notificationsEnabled]);
    }

    await client.query(`
      DELETE FROM ${SCHEMA}.saved_collections c
      WHERE c.device_id = $1 AND c.kind = 'sorted'
        AND NOT EXISTS (
          SELECT 1 FROM ${SCHEMA}.saved_items i
          WHERE i.device_id = c.device_id AND i.collection_id = c.collection_id
        )
    `, [deviceId]);
    await assertImportCapacity(client, deviceId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function mutationCapacity(client, deviceId, op, value) {
  if (op === 'favorite.put') {
    const result = await client.query(`
      SELECT
        EXISTS(SELECT 1 FROM ${SCHEMA}.saved_items WHERE device_id = $1 AND collection_id = $2 AND item_key = $3) AS exists,
        (SELECT COUNT(*)::int FROM ${SCHEMA}.saved_items WHERE device_id = $1 AND collection_id = $2) AS count
    `, [deviceId, FAVORITES_ID, value.itemKey]);
    if (!result.rows[0]?.exists && result.rows[0]?.count >= MAX_FAVORITES) {
      throw badRequest('favorite limit reached');
    }
    return;
  }

  if (op === 'preset.put') {
    const result = await client.query(`
      SELECT
        EXISTS(SELECT 1 FROM ${SCHEMA}.saved_presets WHERE device_id = $1 AND preset_id = $2) AS exists,
        (SELECT COUNT(*)::int FROM ${SCHEMA}.saved_presets WHERE device_id = $1) AS count
    `, [deviceId, value.presetId]);
    if (!result.rows[0]?.exists && result.rows[0]?.count >= MAX_PRESETS) {
      throw badRequest('preset limit reached');
    }
  }
}

async function mutateSavedState(credentials, raw) {
  const {deviceId} = credentials;
  const value = cleanObject(raw);
  const op = String(value?.op || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureInstallation(client, credentials);

    if (op === 'favorite.put') {
      const key = cleanItemKey(value.itemKey);
      const listing = cleanObject(value.listing);
      if (!key || !listing) throw badRequest('invalid favorite payload');
      await mutationCapacity(client, deviceId, op, {itemKey: key});
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_collections(device_id, collection_id, kind, title)
        VALUES ($1, $2, 'favorites', 'Favorites')
        ON CONFLICT (device_id, collection_id) DO UPDATE SET updated_at = NOW()
      `, [deviceId, FAVORITES_ID]);
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_items(device_id, collection_id, item_key, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (device_id, collection_id, item_key) DO UPDATE SET
          payload = EXCLUDED.payload,
          updated_at = NOW()
      `, [deviceId, FAVORITES_ID, key, JSON.stringify(listing)]);
    } else if (op === 'favorite.delete') {
      const key = cleanItemKey(value.itemKey);
      if (!key) throw badRequest('invalid favorite key');
      await client.query(`
        DELETE FROM ${SCHEMA}.saved_items
        WHERE device_id = $1 AND collection_id = $2 AND item_key = $3
      `, [deviceId, FAVORITES_ID, key]);
    } else if (op === 'sorted.put') {
      const collectionId = cleanSavedStateId(value.collectionId);
      const key = cleanItemKey(value.itemKey);
      const listing = cleanObject(value.listing);
      if (!collectionId || collectionId === FAVORITES_ID || !key || !listing) {
        throw badRequest('invalid sorted payload');
      }

      const existing = await client.query(`
        SELECT EXISTS(
          SELECT 1
          FROM ${SCHEMA}.saved_items i
          JOIN ${SCHEMA}.saved_collections c
            ON c.device_id = i.device_id AND c.collection_id = i.collection_id
          WHERE i.device_id = $1 AND i.item_key = $2 AND c.kind = 'sorted'
        ) AS exists
      `, [deviceId, key]);
      const existed = existing.rows[0]?.exists === true;

      await client.query(`
        DELETE FROM ${SCHEMA}.saved_items i
        USING ${SCHEMA}.saved_collections c
        WHERE i.device_id = $1 AND i.item_key = $2
          AND i.device_id = c.device_id AND i.collection_id = c.collection_id
          AND c.kind = 'sorted'
      `, [deviceId, key]);
      await client.query(`
        DELETE FROM ${SCHEMA}.saved_collections c
        WHERE c.device_id = $1 AND c.kind = 'sorted'
          AND NOT EXISTS (
            SELECT 1 FROM ${SCHEMA}.saved_items i
            WHERE i.device_id = c.device_id AND i.collection_id = c.collection_id
          )
      `, [deviceId]);

      const capacity = await client.query(`
        SELECT
          EXISTS(SELECT 1 FROM ${SCHEMA}.saved_collections WHERE device_id = $1 AND collection_id = $2 AND kind = 'sorted') AS collection_exists,
          (SELECT COUNT(*)::int FROM ${SCHEMA}.saved_collections WHERE device_id = $1 AND kind = 'sorted') AS collections,
          (SELECT COUNT(*)::int FROM ${SCHEMA}.saved_items i JOIN ${SCHEMA}.saved_collections c ON c.device_id = i.device_id AND c.collection_id = i.collection_id WHERE i.device_id = $1 AND c.kind = 'sorted') AS items
      `, [deviceId, collectionId]);
      const counts = capacity.rows[0] || {};
      if (!counts.collection_exists && counts.collections >= MAX_SORTED_COLLECTIONS) {
        throw badRequest('sorted collection limit reached');
      }
      if (!existed && counts.items >= MAX_SORTED_ITEMS) {
        throw badRequest('sorted item limit reached');
      }

      await client.query(`
        INSERT INTO ${SCHEMA}.saved_collections(device_id, collection_id, kind, title, is_preset, preset_name)
        VALUES ($1, $2, 'sorted', $3, $4, $5)
        ON CONFLICT (device_id, collection_id) DO UPDATE SET
          title = EXCLUDED.title,
          is_preset = EXCLUDED.is_preset,
          preset_name = EXCLUDED.preset_name,
          updated_at = NOW()
      `, [
        deviceId,
        collectionId,
        cleanTitle(value.collectionTitle),
        value.isPreset === true,
        value.presetName == null ? null : cleanTitle(value.presetName),
      ]);
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_items(device_id, collection_id, item_key, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (device_id, collection_id, item_key) DO UPDATE SET
          payload = EXCLUDED.payload,
          updated_at = NOW()
      `, [deviceId, collectionId, key, JSON.stringify(listing)]);
    } else if (op === 'sorted.delete') {
      const collectionId = cleanSavedStateId(value.collectionId);
      const key = cleanItemKey(value.itemKey);
      if (!collectionId || collectionId === FAVORITES_ID || !key) {
        throw badRequest('invalid sorted key');
      }
      await client.query(`
        DELETE FROM ${SCHEMA}.saved_items
        WHERE device_id = $1 AND collection_id = $2 AND item_key = $3
      `, [deviceId, collectionId, key]);
      await client.query(`
        DELETE FROM ${SCHEMA}.saved_collections c
        WHERE c.device_id = $1 AND c.collection_id = $2 AND c.kind = 'sorted'
          AND NOT EXISTS (
            SELECT 1 FROM ${SCHEMA}.saved_items i
            WHERE i.device_id = c.device_id AND i.collection_id = c.collection_id
          )
      `, [deviceId, collectionId]);
    } else if (op === 'sorted.deleteCollection') {
      const collectionId = cleanSavedStateId(value.collectionId);
      if (!collectionId || collectionId === FAVORITES_ID) {
        throw badRequest('invalid collection id');
      }
      await client.query(`
        DELETE FROM ${SCHEMA}.saved_collections
        WHERE device_id = $1 AND collection_id = $2 AND kind = 'sorted'
      `, [deviceId, collectionId]);
    } else if (op === 'preset.put') {
      const preset = normalizePreset(value.preset);
      if (!preset) throw badRequest('invalid preset payload');
      await mutationCapacity(client, deviceId, op, {presetId: preset.id});
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_presets(device_id, preset_id, name, filters, enabled, notifications_enabled)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (device_id, preset_id) DO UPDATE SET
          name = EXCLUDED.name,
          filters = EXCLUDED.filters,
          enabled = EXCLUDED.enabled,
          notifications_enabled = EXCLUDED.notifications_enabled,
          updated_at = NOW()
      `, [
        deviceId,
        preset.id,
        preset.name,
        JSON.stringify(preset.filters),
        preset.enabled,
        preset.notificationsEnabled,
      ]);
    } else if (op === 'preset.delete') {
      const presetId = cleanSavedStateId(value.presetId);
      if (!presetId) throw badRequest('invalid preset id');
      await client.query(`
        DELETE FROM ${SCHEMA}.saved_presets
        WHERE device_id = $1 AND preset_id = $2
      `, [deviceId, presetId]);
    } else {
      throw badRequest('unsupported saved state mutation');
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function sendSavedStateError(res, error, fallback) {
  if (error?.statusCode === 400) return res.status(400).json({error: error.message});
  if (error?.statusCode === 401) return res.status(401).json({error: 'Invalid installation credentials'});
  console.error(`[mobile-saved-state] ${fallback}:`, error);
  return res.status(500).json({error: 'Could not access saved state'});
}

export function registerMobileSavedStateRoutes(app) {
  app.get('/api/mobile/saved-state', async (req, res) => {
    if (!checkRate(req, res, 'mobile-saved-state-read', 250)) return;
    const credentials = credentialsFromRequest(req);
    if (!credentials) return res.status(401).json({error: 'Missing installation credentials'});
    try {
      return res.json(await savedStateSnapshot(credentials));
    } catch (error) {
      return sendSavedStateError(res, error, 'read failed');
    }
  });

  app.post('/api/mobile/saved-state/import', async (req, res) => {
    if (!checkRate(req, res, 'mobile-saved-state-import', 250)) return;
    const credentials = credentialsFromRequest(req);
    if (!credentials) return res.status(401).json({error: 'Missing installation credentials'});
    try {
      await importLegacyState(credentials, req.body || {});
      return res.json({ok: true});
    } catch (error) {
      return sendSavedStateError(res, error, 'import failed');
    }
  });

  app.post('/api/mobile/saved-state/mutate', async (req, res) => {
    if (!checkRate(req, res, 'mobile-saved-state-mutate', 100)) return;
    const credentials = credentialsFromRequest(req);
    if (!credentials) return res.status(401).json({error: 'Missing installation credentials'});
    try {
      await mutateSavedState(credentials, req.body);
      return res.json({ok: true});
    } catch (error) {
      return sendSavedStateError(res, error, 'mutation failed');
    }
  });
}
