import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { config } from './config.mjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.SUBSCRIPTIONS_DB_POOL_MAX) || 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
pool.on('error', (error) => console.error('[subscription-bot:db] idle client error:', error.message));

const schema = config.dbSchema;
let schemaPromise;

function token() {
  return randomBytes(18).toString('base64url');
}

export function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.users (
        telegram_user_id BIGINT PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        username TEXT,
        first_name TEXT,
        language VARCHAR(2) NOT NULL DEFAULT 'ru',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.subscriptions (
        id BIGSERIAL PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL REFERENCES ${schema}.users(telegram_user_id) ON DELETE CASCADE,
        kind VARCHAR(16) NOT NULL CHECK (kind IN ('flats', 'jobs', 'candidates')),
        name TEXT NOT NULL,
        search_url TEXT NOT NULL,
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        initialized BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_checked_at TIMESTAMPTZ
      );
    `);
    await pool.query(`ALTER TABLE ${schema}.subscriptions ADD COLUMN IF NOT EXISTS initialized BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.deliveries (
        telegram_user_id BIGINT NOT NULL,
        kind VARCHAR(16) NOT NULL,
        item_key TEXT NOT NULL,
        first_subscription_id BIGINT REFERENCES ${schema}.subscriptions(id) ON DELETE SET NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (telegram_user_id, kind, item_key)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.subscription_seen (
        subscription_id BIGINT NOT NULL REFERENCES ${schema}.subscriptions(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (subscription_id, item_key)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.edit_sessions (
        token VARCHAR(48) PRIMARY KEY,
        subscription_id BIGINT NOT NULL,
        telegram_user_id BIGINT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.handoffs (
        token VARCHAR(48) PRIMARY KEY,
        search_url TEXT NOT NULL,
        edit_token VARCHAR(48),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS subscriptions_enabled_idx ON ${schema}.subscriptions(enabled, id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON ${schema}.subscriptions(telegram_user_id, id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS deliveries_sent_idx ON ${schema}.deliveries(sent_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS subscription_seen_seen_idx ON ${schema}.subscription_seen(subscription_id, seen_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS handoffs_expiry_idx ON ${schema}.handoffs(expires_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS edit_sessions_expiry_idx ON ${schema}.edit_sessions(expires_at);`);
  })().catch((error) => {
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}

export async function upsertUser(from, chatId, language) {
  await ensureSchema();
  const result = await pool.query(`
    INSERT INTO ${schema}.users (telegram_user_id, chat_id, username, first_name, language)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (telegram_user_id) DO UPDATE SET
      chat_id = EXCLUDED.chat_id,
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      updated_at = NOW()
    RETURNING *;
  `, [from.id, chatId, from.username || null, from.first_name || null, language]);
  return result.rows[0];
}

export async function getUser(userId) {
  await ensureSchema();
  const result = await pool.query(`SELECT * FROM ${schema}.users WHERE telegram_user_id = $1`, [userId]);
  return result.rows[0] || null;
}

export async function setUserLanguage(userId, language) {
  await ensureSchema();
  await pool.query(`UPDATE ${schema}.users SET language = $2, updated_at = NOW() WHERE telegram_user_id = $1`, [userId, language]);
}

export async function createSubscription(userId, kind, name, searchUrl, filters) {
  await ensureSchema();
  const result = await pool.query(`
    INSERT INTO ${schema}.subscriptions (telegram_user_id, kind, name, search_url, filters)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING *;
  `, [userId, kind, name, searchUrl, JSON.stringify(filters || {})]);
  return result.rows[0];
}

export async function updateSubscriptionSearch(id, userId, searchUrl, filters) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      UPDATE ${schema}.subscriptions
      SET search_url = $3, filters = $4::jsonb, initialized = FALSE, updated_at = NOW(), last_checked_at = NULL
      WHERE id = $1 AND telegram_user_id = $2
      RETURNING *;
    `, [id, userId, searchUrl, JSON.stringify(filters || {})]);
    if (result.rowCount) {
      await client.query(`DELETE FROM ${schema}.subscription_seen WHERE subscription_id = $1`, [id]);
    }
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function renameSubscription(id, userId, name) {
  await ensureSchema();
  const result = await pool.query(`
    UPDATE ${schema}.subscriptions SET name = $3, updated_at = NOW()
    WHERE id = $1 AND telegram_user_id = $2 RETURNING *;
  `, [id, userId, name]);
  return result.rows[0] || null;
}

export async function setSubscriptionEnabled(id, userId, enabled) {
  await ensureSchema();
  const result = await pool.query(`
    UPDATE ${schema}.subscriptions
    SET enabled = $3,
        initialized = CASE WHEN $3::boolean = TRUE THEN FALSE ELSE initialized END,
        last_checked_at = CASE WHEN $3::boolean = TRUE THEN NULL ELSE last_checked_at END,
        updated_at = NOW()
    WHERE id = $1 AND telegram_user_id = $2
    RETURNING *;
  `, [id, userId, enabled]);
  if (result.rowCount && enabled) {
    await pool.query(`DELETE FROM ${schema}.subscription_seen WHERE subscription_id = $1`, [id]);
  }
  return result.rows[0] || null;
}

export async function deleteSubscription(id, userId) {
  await ensureSchema();
  const result = await pool.query(`DELETE FROM ${schema}.subscriptions WHERE id = $1 AND telegram_user_id = $2`, [id, userId]);
  return result.rowCount > 0;
}

export async function getSubscription(id, userId) {
  await ensureSchema();
  const result = await pool.query(`
    SELECT s.*, u.chat_id, u.language
    FROM ${schema}.subscriptions s
    JOIN ${schema}.users u ON u.telegram_user_id = s.telegram_user_id
    WHERE s.id = $1 AND s.telegram_user_id = $2;
  `, [id, userId]);
  return result.rows[0] || null;
}

export async function listUserSubscriptions(userId) {
  await ensureSchema();
  const result = await pool.query(`
    SELECT * FROM ${schema}.subscriptions
    WHERE telegram_user_id = $1 ORDER BY enabled DESC, id ASC;
  `, [userId]);
  return result.rows;
}

export async function listEnabledSubscriptions() {
  await ensureSchema();
  const result = await pool.query(`
    SELECT s.*, u.chat_id, u.language
    FROM ${schema}.subscriptions s
    JOIN ${schema}.users u ON u.telegram_user_id = s.telegram_user_id
    WHERE s.enabled = TRUE
    ORDER BY s.id ASC;
  `);
  return result.rows;
}

export async function createEditSession(id, userId) {
  await ensureSchema();
  const sub = await getSubscription(id, userId);
  if (!sub) return null;
  const value = token();
  await pool.query(`
    INSERT INTO ${schema}.edit_sessions (token, subscription_id, telegram_user_id, expires_at)
    VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes');
  `, [value, id, userId]);
  return value;
}

export async function claimHandoff(value, userId) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT h.token, h.search_url, h.edit_token,
             e.subscription_id, e.telegram_user_id AS edit_user_id,
             e.expires_at AS edit_expires_at, e.consumed_at AS edit_consumed_at
      FROM ${schema}.handoffs h
      LEFT JOIN ${schema}.edit_sessions e ON e.token = h.edit_token
      WHERE h.token = $1
        AND h.consumed_at IS NULL
        AND h.expires_at > NOW()
      FOR UPDATE OF h;
    `, [value]);
    const row = result.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    if (row.edit_token) {
      const ownerOk = String(row.edit_user_id || '') === String(userId);
      const editValid = row.edit_expires_at && !row.edit_consumed_at && new Date(row.edit_expires_at).getTime() > Date.now();
      if (!ownerOk || !editValid) {
        await client.query('ROLLBACK');
        return { forbidden: true };
      }
      await client.query(`UPDATE ${schema}.edit_sessions SET consumed_at = NOW() WHERE token = $1`, [row.edit_token]);
    }
    await client.query(`UPDATE ${schema}.handoffs SET consumed_at = NOW() WHERE token = $1`, [value]);
    await client.query('COMMIT');
    return {
      searchUrl: row.search_url,
      subscriptionId: row.subscription_id ? Number(row.subscription_id) : null,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function hasDelivery(userId, kind, itemKey) {
  await ensureSchema();
  const result = await pool.query(`
    SELECT 1 FROM ${schema}.deliveries
    WHERE telegram_user_id = $1 AND kind = $2 AND item_key = $3;
  `, [userId, kind, itemKey]);
  return result.rowCount > 0;
}

export async function markDelivered(userId, kind, itemKey, subscriptionId) {
  await ensureSchema();
  const result = await pool.query(`
    INSERT INTO ${schema}.deliveries (telegram_user_id, kind, item_key, first_subscription_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telegram_user_id, kind, item_key) DO NOTHING;
  `, [userId, kind, itemKey, subscriptionId]);
  return result.rowCount > 0;
}

export async function hasSubscriptionSeen(subscriptionId, itemKey) {
  await ensureSchema();
  const result = await pool.query(`
    SELECT 1 FROM ${schema}.subscription_seen
    WHERE subscription_id = $1 AND item_key = $2;
  `, [subscriptionId, itemKey]);
  return result.rowCount > 0;
}

export async function markSubscriptionSeen(subscriptionId, itemKey) {
  await ensureSchema();
  const result = await pool.query(`
    INSERT INTO ${schema}.subscription_seen (subscription_id, item_key)
    VALUES ($1, $2)
    ON CONFLICT (subscription_id, item_key) DO NOTHING;
  `, [subscriptionId, itemKey]);
  return result.rowCount > 0;
}

export async function primeSubscriptionSeen(subscriptionId, itemKeys) {
  await ensureSchema();
  if (!itemKeys.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of itemKeys) {
      await client.query(`
        INSERT INTO ${schema}.subscription_seen (subscription_id, item_key)
        VALUES ($1, $2)
        ON CONFLICT (subscription_id, item_key) DO NOTHING;
      `, [subscriptionId, key]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markSubscriptionInitialized(id) {
  await ensureSchema();
  await pool.query(`UPDATE ${schema}.subscriptions SET initialized = TRUE, last_checked_at = NOW() WHERE id = $1`, [id]);
}

export async function touchSubscription(id) {
  await ensureSchema();
  await pool.query(`UPDATE ${schema}.subscriptions SET last_checked_at = NOW() WHERE id = $1`, [id]);
}

export async function closeDatabase() {
  await pool.end();
}
