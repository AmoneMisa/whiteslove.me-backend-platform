// Saved lists for jobs and CVs under the site's Google account (migration 060).
//
// The flats saved state (mobile-saved-state.js) models listings, sorted
// collections and flat filter presets. Jobs and CV pages need less: bounded
// lists of items -- favourites, hidden, recently viewed, seen marks and search
// presets -- so they get one generic table instead of copies of those rules.
//
// Authentication and account routing are shared with flats: the same
// installation credentials, and ensureInstallation() redirects a linked
// installation to its account's rows. Linking, signing out and deleting an
// account cover these rows too (mobile-account.js).
//
// Every list is a window of the newest N items. Writing past N drops the
// oldest, the same rule the browser's local copy follows, so a busy "seen"
// list never turns into failed requests.
import {pool} from '../infrastructure/database/pool.js';
import {checkRate} from '../support/request-rate-limit.js';
import {cleanItemKey, credentialsFromRequest, ensureInstallation, sendSavedStateError} from './mobile-saved-state.js';

const SCHEMA = 'user_data';

export const LIST_DOMAINS = Object.freeze(['jobs', 'cv']);
export const LIST_LIMITS = Object.freeze({
  favorites: 500,
  hidden: 500,
  recent: 50,
  seen: 2000,
  presets: 100,
});
const LIST_NAMES = Object.keys(LIST_LIMITS);
const MAX_OPS = 200;
// A vacancy or CV snapshot; far above a real one, low enough that nobody can
// park documents here.
const MAX_PAYLOAD_BYTES = 64 * 1024;

function badRequest(message) {
  return Object.assign(new Error(message), {statusCode: 400});
}

export function cleanDomain(value) {
  const domain = String(value || '');
  return LIST_DOMAINS.includes(domain) ? domain : null;
}

function cleanList(value) {
  const list = String(value || '');
  return LIST_NAMES.includes(list) ? list : null;
}

function cleanPayload(value) {
  if (value == null) return '{}';
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES ? json : null;
}

/**
 * One list operation, validated:
 *   put    upsert and move to the front (a new favourite, a view)
 *   add    insert only if absent (merging a browser's copy in; never
 *          overwrites or reorders what the account already has)
 *   delete remove one item
 *   clear  empty the list
 */
export function normalizeListOp(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const op = String(raw.op || '');
  const list = cleanList(raw.list);
  if (!list) return null;
  if (op === 'clear') return {op, list};
  const key = cleanItemKey(raw.key);
  if (!key) return null;
  if (op === 'delete') return {op, list, key};
  if (op !== 'put' && op !== 'add') return null;
  const payload = cleanPayload(raw.payload);
  return payload == null ? null : {op, list, key, payload};
}

export function normalizeListOps(body) {
  const raw = Array.isArray(body?.ops) ? body.ops : null;
  if (!raw || !raw.length) throw badRequest('no list operations');
  if (raw.length > MAX_OPS) throw badRequest('too many list operations');
  const ops = raw.map(normalizeListOp);
  if (ops.some((op) => !op)) throw badRequest('invalid list operation');
  return ops;
}

/** Drops the oldest rows past each list's limit. */
export async function trimLists(client, deviceId, domain = null) {
  for (const [list, limit] of Object.entries(LIST_LIMITS)) {
    await client.query(`
      DELETE FROM ${SCHEMA}.saved_list_items t
      USING (
        SELECT domain, item_key,
               ROW_NUMBER() OVER (PARTITION BY domain ORDER BY updated_at DESC, item_key) AS rank
        FROM ${SCHEMA}.saved_list_items
        WHERE device_id = $1 AND list = $2 AND ($4::varchar IS NULL OR domain = $4::varchar)
      ) ranked
      WHERE t.device_id = $1 AND t.list = $2
        AND t.domain = ranked.domain AND t.item_key = ranked.item_key
        AND ranked.rank > $3
    `, [deviceId, list, limit, domain]);
  }
}

async function readLists(credentials, domain) {
  const client = await pool.connect();
  try {
    const deviceId = await ensureInstallation(client, credentials);
    const result = await client.query(`
      SELECT list, item_key, payload
      FROM ${SCHEMA}.saved_list_items
      WHERE device_id = $1 AND domain = $2
      ORDER BY updated_at DESC, item_key
    `, [deviceId, domain]);
    const lists = Object.fromEntries(LIST_NAMES.map((list) => [list, []]));
    for (const row of result.rows) lists[row.list]?.push({key: row.item_key, payload: row.payload});
    return lists;
  } finally {
    client.release();
  }
}

async function applyListOps(credentials, domain, ops) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deviceId = await ensureInstallation(client, credentials);
    for (const item of ops) {
      if (item.op === 'clear') {
        await client.query(`
          DELETE FROM ${SCHEMA}.saved_list_items
          WHERE device_id = $1 AND domain = $2 AND list = $3
        `, [deviceId, domain, item.list]);
      } else if (item.op === 'delete') {
        await client.query(`
          DELETE FROM ${SCHEMA}.saved_list_items
          WHERE device_id = $1 AND domain = $2 AND list = $3 AND item_key = $4
        `, [deviceId, domain, item.list, item.key]);
      } else {
        await client.query(`
          INSERT INTO ${SCHEMA}.saved_list_items(device_id, domain, list, item_key, payload)
          VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (device_id, domain, list, item_key) ${item.op === 'put'
            ? 'DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()'
            : 'DO NOTHING'}
        `, [deviceId, domain, item.list, item.key, item.payload]);
      }
    }
    await trimLists(client, deviceId, domain);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function registerMobileListRoutes(app) {
  app.get('/api/mobile/lists/:domain', async (req, res) => {
    if (!checkRate(req, res, 'mobile-lists-read', 250)) return;
    const domain = cleanDomain(req.params.domain);
    if (!domain) return res.status(404).json({error: 'Unknown list domain'});
    const credentials = credentialsFromRequest(req);
    if (!credentials) return res.status(401).json({error: 'Missing installation credentials'});
    try {
      return res.json(await readLists(credentials, domain));
    } catch (error) {
      return sendSavedStateError(res, error, 'list read failed');
    }
  });

  app.post('/api/mobile/lists/:domain', async (req, res) => {
    if (!checkRate(req, res, 'mobile-lists-write', 100)) return;
    const domain = cleanDomain(req.params.domain);
    if (!domain) return res.status(404).json({error: 'Unknown list domain'});
    const credentials = credentialsFromRequest(req);
    if (!credentials) return res.status(401).json({error: 'Missing installation credentials'});
    try {
      await applyListOps(credentials, domain, normalizeListOps(req.body));
      return res.json({ok: true});
    } catch (error) {
      return sendSavedStateError(res, error, 'list write failed');
    }
  });
}
