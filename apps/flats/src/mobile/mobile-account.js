// "Sign in with Google": links an installation (a phone or a browser) to an
// account so every linked installation shares one set of saved flats, sorted
// collections and presets -- and the site's saved jobs and CVs
// (mobile-lists.js). Presets carry their notification flags, so a phone
// that signs in gets the account's subscriptions and registers them for push
// with its own token (subscriptions.mobile_devices stays per device).
//
// Storage: user_data.accounts (migration 059) keeps only Google's `sub`. The
// shared state lives under the synthetic installation 'acct:<account_id>' and
// the saved-state API redirects linked installations there (ensureInstallation).
//
// Linking an anonymous installation is a union merge: its saved state is added
// to the account's -- nothing already in the account is overwritten or
// removed -- and then its own copy is dropped, so there is one copy. Signing
// out unlinks and leaves the installation empty: the account's data stays with
// the account, not on a device someone else may use next.
import {randomBytes} from 'node:crypto';

import {pool} from '../infrastructure/database/pool.js';
import {checkRate} from '../support/request-rate-limit.js';
import {createGoogleIdTokenVerifier, GoogleTokenError} from './google-id-token.js';
import {
  accountInstallationId,
  assertImportCapacity,
  credentialsFromRequest,
  ensureInstallation,
  installationSecretHash,
  sendSavedStateError,
} from './mobile-saved-state.js';
import {trimLists} from './mobile-lists.js';

const SCHEMA = 'user_data';

function newAccountId() {
  return randomBytes(12).toString('hex');
}

/** The installation's own id and its account, after verifying its secret. */
async function verifiedInstallation(client, credentials) {
  const owner = await ensureInstallation(client, credentials);
  const accountId = owner === credentials.deviceId ? null : owner.slice(accountInstallationId('').length);
  return {deviceId: credentials.deviceId, accountId};
}

async function findOrCreateAccount(client, googleSub) {
  const result = await client.query(`
    INSERT INTO ${SCHEMA}.accounts(account_id, google_sub)
    VALUES ($1, $2)
    ON CONFLICT (google_sub) DO UPDATE SET last_sign_in_at = NOW()
    RETURNING account_id
  `, [newAccountId(), googleSub]);
  const accountId = result.rows[0].account_id;
  // The account's state holder. Its secret hash is of bytes nobody keeps, so
  // no client can authenticate as it; it is reached only through linking.
  await client.query(`
    INSERT INTO ${SCHEMA}.installations(device_id, sync_secret_hash)
    VALUES ($1, $2)
    ON CONFLICT (device_id) DO NOTHING
  `, [accountInstallationId(accountId), installationSecretHash(randomBytes(32).toString('hex'))]);
  return accountId;
}

/**
 * Adds everything saved under `fromId` to `toId` without overwriting or
 * removing anything already there -- the same rules as the saved-state import:
 * favourites and presets by key, and a listing sits in at most one sorted
 * collection, so a listing the account already sorted keeps its place.
 */
export async function mergeSavedState(client, fromId, toId) {
  await client.query(`
    INSERT INTO ${SCHEMA}.saved_collections
      (device_id, collection_id, kind, title, is_preset, preset_name, position)
    SELECT $2::varchar, collection_id, kind, title, is_preset, preset_name, position
    FROM ${SCHEMA}.saved_collections
    WHERE device_id = $1::varchar
    ON CONFLICT (device_id, collection_id) DO NOTHING
  `, [fromId, toId]);
  await client.query(`
    INSERT INTO ${SCHEMA}.saved_items(device_id, collection_id, item_key, payload, position)
    SELECT $2::varchar, i.collection_id, i.item_key, i.payload, i.position
    FROM ${SCHEMA}.saved_items i
    JOIN ${SCHEMA}.saved_collections c
      ON c.device_id = i.device_id AND c.collection_id = i.collection_id
    WHERE i.device_id = $1::varchar
      AND (
        c.kind = 'favorites'
        OR NOT EXISTS (
          SELECT 1
          FROM ${SCHEMA}.saved_items ti
          JOIN ${SCHEMA}.saved_collections tc
            ON tc.device_id = ti.device_id AND tc.collection_id = ti.collection_id
          WHERE ti.device_id = $2::varchar AND ti.item_key = i.item_key AND tc.kind = 'sorted'
        )
      )
    ON CONFLICT (device_id, collection_id, item_key) DO NOTHING
  `, [fromId, toId]);
  await client.query(`
    INSERT INTO ${SCHEMA}.saved_presets
      (device_id, preset_id, name, filters, enabled, notifications_enabled, position)
    SELECT $2::varchar, preset_id, name, filters, enabled, notifications_enabled, position
    FROM ${SCHEMA}.saved_presets
    WHERE device_id = $1::varchar
    ON CONFLICT (device_id, preset_id) DO NOTHING
  `, [fromId, toId]);
  // Jobs and CV lists (migration 060): items the account lacks, keeping the
  // account's own copy and order; trimLists then applies the list windows.
  await client.query(`
    INSERT INTO ${SCHEMA}.saved_list_items(device_id, domain, list, item_key, payload, created_at, updated_at)
    SELECT $2::varchar, domain, list, item_key, payload, created_at, updated_at
    FROM ${SCHEMA}.saved_list_items
    WHERE device_id = $1::varchar
    ON CONFLICT (device_id, domain, list, item_key) DO NOTHING
  `, [fromId, toId]);
  // A sorted collection whose every listing was already sorted elsewhere in
  // the account came over empty; drop it, as the import does.
  await client.query(`
    DELETE FROM ${SCHEMA}.saved_collections c
    WHERE c.device_id = $1::varchar AND c.kind = 'sorted'
      AND NOT EXISTS (
        SELECT 1 FROM ${SCHEMA}.saved_items i
        WHERE i.device_id = c.device_id AND i.collection_id = c.collection_id
      )
  `, [toId]);
}

async function clearSavedState(client, deviceId) {
  // Items cascade from their collections.
  await client.query(`DELETE FROM ${SCHEMA}.saved_collections WHERE device_id = $1`, [deviceId]);
  await client.query(`DELETE FROM ${SCHEMA}.saved_presets WHERE device_id = $1`, [deviceId]);
  await client.query(`DELETE FROM ${SCHEMA}.saved_list_items WHERE device_id = $1`, [deviceId]);
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Links the installation to the Google account, merging its saved state in
 * when it was anonymous. Switching straight from one account to another merges
 * nothing: an installation linked to account A holds no state of its own, and
 * copying A's into B would mix two people's data.
 */
export async function linkGoogleAccount(credentials, googleSub) {
  return inTransaction(async (client) => {
    const installation = await verifiedInstallation(client, credentials);
    const accountId = await findOrCreateAccount(client, googleSub);
    if (installation.accountId === accountId) return {accountId, merged: false};

    const accountOwner = accountInstallationId(accountId);
    const merged = !installation.accountId;
    if (merged) {
      await mergeSavedState(client, installation.deviceId, accountOwner);
      // Rolls the whole link back rather than silently dropping items.
      await assertImportCapacity(client, accountOwner);
      // Jobs/CV lists are windows, not quotas: keep the newest, as they do.
      await trimLists(client, accountOwner);
      await clearSavedState(client, installation.deviceId);
    }
    await client.query(`
      UPDATE ${SCHEMA}.installations SET account_id = $2, updated_at = NOW()
      WHERE device_id = $1
    `, [installation.deviceId, accountId]);
    return {accountId, merged};
  });
}

export async function accountStatus(credentials) {
  return inTransaction(async (client) => {
    const {accountId} = await verifiedInstallation(client, credentials);
    return {signedIn: Boolean(accountId), provider: accountId ? 'google' : null};
  });
}

/** Unlinks this installation; the account and its data are untouched. */
export async function signOut(credentials) {
  return inTransaction(async (client) => {
    const {deviceId} = await verifiedInstallation(client, credentials);
    await client.query(`
      UPDATE ${SCHEMA}.installations SET account_id = NULL, updated_at = NOW()
      WHERE device_id = $1
    `, [deviceId]);
    return {signedIn: false};
  });
}

/**
 * Erases the account: its saved state and its Google subject id. Every linked
 * installation is unlinked by the foreign key (ON DELETE SET NULL) and carries
 * on anonymously and empty.
 */
export async function deleteAccount(credentials) {
  return inTransaction(async (client) => {
    const {accountId} = await verifiedInstallation(client, credentials);
    if (!accountId) return {deleted: false};
    await client.query(`DELETE FROM ${SCHEMA}.installations WHERE device_id = $1`, [accountInstallationId(accountId)]);
    await client.query(`DELETE FROM ${SCHEMA}.accounts WHERE account_id = $1`, [accountId]);
    return {deleted: true};
  });
}

export function registerMobileAccountRoutes(app, {verifyGoogleIdToken = createGoogleIdTokenVerifier()} = {}) {
  const withCredentials = (bucket, windowMs, handler) => async (req, res) => {
    if (!checkRate(req, res, bucket, windowMs)) return;
    const credentials = credentialsFromRequest(req);
    if (!credentials) return res.status(401).json({error: 'Missing installation credentials'});
    try {
      return res.json(await handler(credentials, req));
    } catch (error) {
      if (error instanceof GoogleTokenError) {
        // The code says which check failed (expired, bad_audience, ...), never
        // anything from the token itself.
        if (error.code === 'not_configured') return res.status(503).json({error: 'Google sign-in is not configured'});
        return res.status(401).json({error: 'Invalid Google sign-in', reason: error.code});
      }
      return sendSavedStateError(res, error, 'account request failed');
    }
  };

  app.get('/api/mobile/account', withCredentials('mobile-account-read', 250, (credentials) => accountStatus(credentials)));

  app.post('/api/mobile/account/google', withCredentials('mobile-account-link', 1000, async (credentials, req) => {
    const {sub} = await verifyGoogleIdToken(req.body?.idToken);
    const {merged} = await linkGoogleAccount(credentials, sub);
    return {signedIn: true, provider: 'google', merged};
  }));

  app.post('/api/mobile/account/sign-out', withCredentials('mobile-account-write', 1000, (credentials) => signOut(credentials)));

  app.post('/api/mobile/account/delete', withCredentials('mobile-account-write', 1000, (credentials) => deleteAccount(credentials)));
}
