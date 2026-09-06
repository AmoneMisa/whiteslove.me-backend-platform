import {pool} from '../infrastructure/database/pool.js';
import {checkRate} from '../support/request-rate-limit.js';

const SCHEMA = 'user_data';
const FAVORITES_ID = 'favorites';
const MAX_FAVORITES = 1000;
const MAX_SORTED_COLLECTIONS = 100;
const MAX_SORTED_ITEMS = 5000;
const MAX_PRESETS = 100;

export function cleanSavedStateId(value, {max = 80, min = 8} = {}) {
  const result = String(value || '').trim();
  if (result.length < min || result.length > max) return null;
  return /^[A-Za-z0-9._:-]+$/.test(result) ? result : null;
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

function normalizeSortedCollection(raw) {
  const value = cleanObject(raw);
  if (!value) return null;
  const id = cleanSavedStateId(value.id);
  if (!id) return null;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems.map((entry) => {
    const item = cleanObject(entry);
    if (!item) return null;
    const key = cleanItemKey(item.key);
    const listing = cleanObject(item.listing ?? item.payload);
    return key && listing ? {key, listing} : null;
  }).filter(Boolean);
  if (items.length !== rawItems.length) return null;
  return {
    id,
    title: cleanTitle(value.title),
    isPreset: value.isPreset === true,
    presetName: value.presetName == null ? null : cleanTitle(value.presetName),
    items,
  };
}

async function ensureInstallation(client, deviceId) {
  await client.query(`
    INSERT INTO ${SCHEMA}.installations(device_id)
    VALUES ($1)
    ON CONFLICT (device_id) DO UPDATE SET updated_at = NOW()
  `, [deviceId]);
}

async function savedStateSnapshot(deviceId) {
  const client = await pool.connect();
  try {
    await ensureInstallation(client, deviceId);
    const [collectionsResult, itemsResult, presetsResult] = await Promise.all([
      client.query(`
        SELECT collection_id, kind, title, is_preset, preset_name
        FROM ${SCHEMA}.saved_collections
        WHERE device_id = $1
        ORDER BY updated_at DESC, collection_id
      `, [deviceId]),
      client.query(`
        SELECT collection_id, item_key, payload
        FROM ${SCHEMA}.saved_items
        WHERE device_id = $1
        ORDER BY updated_at DESC, item_key
      `, [deviceId]),
      client.query(`
        SELECT preset_id, name, filters, enabled, notifications_enabled
        FROM ${SCHEMA}.saved_presets
        WHERE device_id = $1
        ORDER BY updated_at DESC, preset_id
      `, [deviceId]),
    ]);

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

async function importLegacyState(deviceId, body) {
  const rawFavorites = Array.isArray(body.favorites) ? body.favorites : [];
  const rawSorted = Array.isArray(body.sorted) ? body.sorted : [];
  const rawPresets = Array.isArray(body.presets) ? body.presets : [];
  if (rawFavorites.length > MAX_FAVORITES || rawSorted.length > MAX_SORTED_COLLECTIONS || rawPresets.length > MAX_PRESETS) {
    throw Object.assign(new Error('saved state exceeds import limits'), {statusCode: 400});
  }

  const favorites = rawFavorites.map((entry) => {
    const value = cleanObject(entry);
    if (!value) return null;
    const key = cleanItemKey(value.key);
    const listing = cleanObject(value.listing ?? value.payload);
    return key && listing ? {key, listing} : null;
  }).filter(Boolean);
  const sorted = rawSorted.map(normalizeSortedCollection).filter(Boolean);
  const presets = rawPresets.map(normalizePreset).filter(Boolean);
  const sortedItems = sorted.reduce((count, collection) => count + collection.items.length, 0);
  if (favorites.length !== rawFavorites.length || sorted.length !== rawSorted.length || presets.length !== rawPresets.length || sortedItems > MAX_SORTED_ITEMS) {
    throw Object.assign(new Error('invalid saved state import payload'), {statusCode: 400});
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureInstallation(client, deviceId);

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
          VALUES ($1, $2, $3, $4::jsonb)
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

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function mutateSavedState(deviceId, raw) {
  const value = cleanObject(raw);
  const op = String(value?.op || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureInstallation(client, deviceId);

    if (op === 'favorite.put') {
      const key = cleanItemKey(value.itemKey);
      const listing = cleanObject(value.listing);
      if (!key || !listing) throw Object.assign(new Error('invalid favorite payload'), {statusCode: 400});
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_collections(device_id, collection_id, kind, title)
        VALUES ($1, $2, 'favorites', 'Favorites')
        ON CONFLICT (device_id, collection_id) DO UPDATE SET updated_at = NOW()
      `, [deviceId, FAVORITES_ID]);
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_items(device_id, collection_id, item_key, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (device_id, collection_id, item_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
      `, [deviceId, FAVORITES_ID, key, JSON.stringify(listing)]);
    } else if (op === 'favorite.delete') {
      const key = cleanItemKey(value.itemKey);
      if (!key) throw Object.assign(new Error('invalid favorite key'), {statusCode: 400});
      await client.query(`DELETE FROM ${SCHEMA}.saved_items WHERE device_id = $1 AND collection_id = $2 AND item_key = $3`, [deviceId, FAVORITES_ID, key]);
    } else if (op === 'sorted.put') {
      const collectionId = cleanSavedStateId(value.collectionId);
      const key = cleanItemKey(value.itemKey);
      const listing = cleanObject(value.listing);
      if (!collectionId || !key || !listing) throw Object.assign(new Error('invalid sorted payload'), {statusCode: 400});
      await client.query(`DELETE FROM ${SCHEMA}.saved_items i USING ${SCHEMA}.saved_collections c WHERE i.device_id = $1 AND i.item_key = $2 AND i.device_id = c.device_id AND i.collection_id = c.collection_id AND c.kind = 'sorted'`, [deviceId, key]);
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_collections(device_id, collection_id, kind, title, is_preset, preset_name)
        VALUES ($1, $2, 'sorted', $3, $4, $5)
        ON CONFLICT (device_id, collection_id) DO UPDATE SET title = EXCLUDED.title, is_preset = EXCLUDED.is_preset, preset_name = EXCLUDED.preset_name, updated_at = NOW()
      `, [deviceId, collectionId, cleanTitle(value.collectionTitle), value.isPreset === true, value.presetName == null ? null : cleanTitle(value.presetName)]);
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_items(device_id, collection_id, item_key, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (device_id, collection_id, item_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
      `, [deviceId, collectionId, key, JSON.stringify(listing)]);
      await client.query(`DELETE FROM ${SCHEMA}.saved_collections c WHERE c.device_id = $1 AND c.kind = 'sorted' AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.saved_items i WHERE i.device_id = c.device_id AND i.collection_id = c.collection_id)`, [deviceId]);
    } else if (op === 'sorted.delete') {
      const collectionId = cleanSavedStateId(value.collectionId);
      const key = cleanItemKey(value.itemKey);
      if (!collectionId || !key) throw Object.assign(new Error('invalid sorted key'), {statusCode: 400});
      await client.query(`DELETE FROM ${SCHEMA}.saved_items WHERE device_id = $1 AND collection_id = $2 AND item_key = $3`, [deviceId, collectionId, key]);
      await client.query(`DELETE FROM ${SCHEMA}.saved_collections c WHERE c.device_id = $1 AND c.collection_id = $2 AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.saved_items i WHERE i.device_id = c.device_id AND i.collection_id = c.collection_id)`, [deviceId, collectionId]);
    } else if (op === 'sorted.deleteCollection') {
      const collectionId = cleanSavedStateId(value.collectionId);
      if (!collectionId) throw Object.assign(new Error('invalid collection id'), {statusCode: 400});
      await client.query(`DELETE FROM ${SCHEMA}.saved_collections WHERE device_id = $1 AND collection_id = $2 AND kind = 'sorted'`, [deviceId, collectionId]);
    } else if (op === 'preset.put') {
      const preset = normalizePreset(value.preset);
      if (!preset) throw Object.assign(new Error('invalid preset payload'), {statusCode: 400});
      await client.query(`
        INSERT INTO ${SCHEMA}.saved_presets(device_id, preset_id, name, filters, enabled, notifications_enabled)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (device_id, preset_id) DO UPDATE SET name = EXCLUDED.name, filters = EXCLUDED.filters, enabled = EXCLUDED.enabled, notifications_enabled = EXCLUDED.notifications_enabled, updated_at = NOW()
      `, [deviceId, preset.id, preset.name, JSON.stringify(preset.filters), preset.enabled, preset.notificationsEnabled]);
    } else if (op === 'preset.delete') {
      const presetId = cleanSavedStateId(value.presetId);
      if (!presetId) throw Object.assign(new Error('invalid preset id'), {statusCode: 400});
      await client.query(`DELETE FROM ${SCHEMA}.saved_presets WHERE device_id = $1 AND preset_id = $2`, [deviceId, presetId]);
    } else {
      throw Object.assign(new Error('unsupported saved state mutation'), {statusCode: 400});
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function registerMobileSavedStateRoutes(app) {
  app.get('/api/mobile/saved-state', async (req, res) => {
    if (!checkRate(req, res, 'mobile-saved-state-read', 250)) return;
    const deviceId = cleanSavedStateId(req.query?.deviceId);
    if (!deviceId) return res.status(400).json({error: 'Invalid deviceId'});
    try {
      return res.json(await savedStateSnapshot(deviceId));
    } catch (error) {
      console.error('[mobile-saved-state] read failed:', error);
      return res.status(500).json({error: 'Could not load saved state'});
    }
  });

  app.post('/api/mobile/saved-state/import', async (req, res) => {
    if (!checkRate(req, res, 'mobile-saved-state-import', 1000)) return;
    const deviceId = cleanSavedStateId(req.body?.deviceId);
    if (!deviceId) return res.status(400).json({error: 'Invalid deviceId'});
    try {
      await importLegacyState(deviceId, req.body || {});
      return res.json({ok: true});
    } catch (error) {
      if (error?.statusCode === 400) return res.status(400).json({error: error.message});
      console.error('[mobile-saved-state] import failed:', error);
      return res.status(500).json({error: 'Could not import saved state'});
    }
  });

  app.post('/api/mobile/saved-state/mutate', async (req, res) => {
    if (!checkRate(req, res, 'mobile-saved-state-mutate', 150)) return;
    const deviceId = cleanSavedStateId(req.body?.deviceId);
    if (!deviceId) return res.status(400).json({error: 'Invalid deviceId'});
    try {
      await mutateSavedState(deviceId, req.body);
      return res.json({ok: true});
    } catch (error) {
      if (error?.statusCode === 400) return res.status(400).json({error: error.message});
      console.error('[mobile-saved-state] mutation failed:', error);
      return res.status(500).json({error: 'Could not save state'});
    }
  });
}
