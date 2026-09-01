import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

const DEFAULT_LEASE_MS = Math.max(
  60_000,
  Number(process.env.QUEUE_TASK_LEASE_SECONDS || 300) * 1000,
);
const DEFAULT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.QUEUE_MAX_ATTEMPTS) || 5,
);
const RETRY_BASE_MS = Math.max(
  5_000,
  Number(process.env.QUEUE_RETRY_BASE_MS) || 30_000,
);
const RETRY_MAX_MS = Math.max(
  RETRY_BASE_MS,
  Number(process.env.QUEUE_RETRY_MAX_MS) || 5 * 60_000,
);
const RECOVERY_INTERVAL_MS = Math.max(
  10_000,
  Math.min(Number(process.env.QUEUE_RECOVERY_INTERVAL_MS) || 30_000, 5 * 60_000),
);
const ENQUEUE_BATCH_SIZE = Math.max(
  50,
  Math.min(Number(process.env.QUEUE_ENQUEUE_BATCH_SIZE) || 500, 2000),
);
const QUEUE_RECOVERY_ADVISORY_LOCK = 742_002;

let lastRecoveryAt = 0;
let recoveryPromise = null;

function taskIdentity(task) {
  return [
    task.queueProtocol || 0,
    task.crawlGeneration || 'legacy',
    task.type || 'unknown',
    task.country || 'unknown',
    task.citySlug || task.city || 'all',
    task.segment || task.channel || 'all',
    task.page || 0,
  ].join(':');
}

function boundedQueueIdentity(value, fallback, maxLength, field) {
  const text = String(value || fallback);
  if (text.length > maxLength) {
    throw new RangeError(`queue ${field} exceeds ${maxLength} characters`);
  }
  return text;
}

function normalizedTask(task) {
  const payload = {
    ...task,
    priority: Math.max(0, Math.trunc(Number(task.priority) || 0)),
    crawlerShard: Math.max(0, Math.trunc(Number(task.crawlerShard) || 0)),
  };
  const crawlGeneration = boundedQueueIdentity(payload.crawlGeneration, 'legacy', 128, 'crawlGeneration');
  const type = boundedQueueIdentity(payload.type, '', 64, 'type');
  const country = boundedQueueIdentity(payload.country, '', 8, 'country').toUpperCase();

  return {
    taskKey: taskIdentity(payload),
    crawlGeneration,
    type,
    country,
    crawlerShard: payload.crawlerShard,
    priority: payload.priority,
    payload,
  };
}

export async function enqueueTasks(tasks, client = pool) {
  const unique = new Map();
  for (const task of tasks || []) {
    const item = normalizedTask(task);
    unique.set(item.taskKey, item);
  }
  const items = [...unique.values()];
  if (!items.length) return 0;

  let inserted = 0;
  for (let offset = 0; offset < items.length; offset += ENQUEUE_BATCH_SIZE) {
    const batch = items.slice(offset, offset + ENQUEUE_BATCH_SIZE).map((item) => ({
      task_key: item.taskKey,
      crawl_generation: item.crawlGeneration,
      type: item.type,
      country: item.country,
      crawler_shard: item.crawlerShard,
      priority: item.priority,
      payload: item.payload,
    }));
    const result = await client.query(
      `
        INSERT INTO crawl_tasks (
          task_key,
          crawl_generation,
          type,
          country,
          crawler_shard,
          priority,
          payload
        )
        SELECT
          input.task_key,
          input.crawl_generation,
          input.type,
          input.country,
          input.crawler_shard,
          input.priority,
          input.payload
        FROM jsonb_to_recordset($1::jsonb) AS input (
          task_key TEXT,
          crawl_generation TEXT,
          type TEXT,
          country TEXT,
          crawler_shard INTEGER,
          priority INTEGER,
          payload JSONB
        )
        ON CONFLICT (task_key) DO NOTHING
        RETURNING id
      `,
      [JSON.stringify(batch)],
    );
    inserted += result.rowCount;
  }
  return inserted;
}

export async function dispatchGenerationIfIdle(tasks, refreshSeconds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Prevent two worker instances from opening the same recurring generation.
    await client.query('SELECT pg_advisory_xact_lock($1)', [742_001]);

    // On-demand custom URL jobs use the same durable queue but must never block
    // or reset the cadence of the authoritative OLX/Telegram crawl generation.
    const pending = await client.query(`
      SELECT COUNT(*)::integer AS count
      FROM crawl_tasks
      WHERE status IN ('pending', 'running')
        AND type <> 'flat.custom.url'
    `);
    if (Number(pending.rows[0]?.count || 0) > 0) {
      await client.query('COMMIT');
      return { queued: 0, reason: 'backlog' };
    }

    const latest = await client.query(`
      SELECT MAX(created_at) AS created_at
      FROM crawl_tasks
      WHERE type <> 'flat.custom.url'
    `);
    const latestAt = latest.rows[0]?.created_at
      ? new Date(latest.rows[0].created_at).getTime()
      : 0;
    const refreshMs = Math.max(60, Number(refreshSeconds) || 1800) * 1000;
    if (latestAt && Date.now() - latestAt < refreshMs) {
      await client.query('COMMIT');
      return {
        queued: 0,
        reason: 'interval',
        retryAfterMs: refreshMs - (Date.now() - latestAt),
      };
    }

    const queued = await enqueueTasks(tasks, client);
    await client.query('COMMIT');
    return { queued, reason: queued ? 'queued' : 'duplicate' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverExpiredTasks(maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const result = await pool.query(
    `
      WITH recovery_guard AS (
        SELECT pg_try_advisory_xact_lock($2) AS locked
      )
      UPDATE crawl_tasks
      SET
        status = CASE WHEN attempts >= $1 THEN 'dead' ELSE 'pending' END,
        run_after = CASE WHEN attempts >= $1 THEN run_after ELSE NOW() END,
        locked_by = NULL,
        lock_token = NULL,
        locked_until = NULL,
        finished_at = CASE WHEN attempts >= $1 THEN COALESCE(finished_at, NOW()) ELSE NULL END,
        last_error = CASE
          WHEN attempts >= $1 THEN COALESCE(last_error, 'worker lease expired')
          ELSE last_error
        END,
        updated_at = NOW()
      WHERE status = 'running'
        AND locked_until IS NOT NULL
        AND locked_until < NOW()
        AND (SELECT locked FROM recovery_guard)
    `,
    [maxAttempts, QUEUE_RECOVERY_ADVISORY_LOCK],
  );
  return result.rowCount;
}

async function maybeRecoverExpiredTasks(maxAttempts) {
  const now = Date.now();
  if (now - lastRecoveryAt < RECOVERY_INTERVAL_MS) return;
  if (recoveryPromise) return recoveryPromise;

  lastRecoveryAt = now;
  recoveryPromise = recoverExpiredTasks(maxAttempts)
    .finally(() => {
      recoveryPromise = null;
    });
  return recoveryPromise;
}

export async function claimTask({
  role,
  shard = 0,
  workerId,
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  await maybeRecoverExpiredTasks(maxAttempts);

  const normalizedRole = role === 'telegram' ? 'telegram' : 'olx';
  const normalizedShard = Math.max(0, Math.trunc(Number(shard) || 0));
  const token = randomUUID();
  const worker = String(workerId || `${normalizedRole}:${normalizedShard}`).slice(0, 200);

  const roleSql = normalizedRole === 'telegram'
    ? `type = 'flat.telegram.channel'`
    : `type = 'flat.olx.page' AND crawler_shard = $1`;
  const params = normalizedRole === 'telegram'
    ? [worker, token, Math.max(60_000, Number(leaseMs) || DEFAULT_LEASE_MS)]
    : [normalizedShard, worker, token, Math.max(60_000, Number(leaseMs) || DEFAULT_LEASE_MS)];
  const workerParam = normalizedRole === 'telegram' ? '$1' : '$2';
  const tokenParam = normalizedRole === 'telegram' ? '$2' : '$3';
  const leaseParam = normalizedRole === 'telegram' ? '$3' : '$4';

  const result = await pool.query(
    `
      WITH candidate AS (
        SELECT id
        FROM crawl_tasks
        WHERE status = 'pending'
          AND run_after <= NOW()
          AND attempts < ${Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS)}
          AND ${roleSql}
        ORDER BY priority DESC, run_after ASC, created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE crawl_tasks AS task
      SET
        status = 'running',
        attempts = task.attempts + 1,
        locked_by = ${workerParam},
        lock_token = ${tokenParam},
        locked_until = NOW() + (${leaseParam}::bigint * INTERVAL '1 millisecond'),
        started_at = COALESCE(task.started_at, NOW()),
        updated_at = NOW()
      FROM candidate
      WHERE task.id = candidate.id
      RETURNING
        task.id,
        task.payload,
        task.attempts,
        task.priority,
        task.lock_token,
        task.locked_until
    `,
    params,
  );

  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    payload: row.payload,
    attempts: Number(row.attempts),
    priority: Number(row.priority),
    lockToken: row.lock_token,
    lockedUntil: row.locked_until,
  };
}

export async function completeTask({ id, lockToken, result }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query(
      `
        SELECT id, status, lock_token
        FROM crawl_tasks
        WHERE id = $1
        FOR UPDATE
      `,
      [id],
    );
    const current = row.rows[0];
    if (!current || current.status !== 'running' || current.lock_token !== lockToken) {
      await client.query('ROLLBACK');
      return { completed: false, reason: 'lost-lease' };
    }

    const nextTasks = Array.isArray(result?.nextTasks) ? result.nextTasks : [];
    const queuedNext = await enqueueTasks(nextTasks, client);
    const storedResult = {
      ok: result?.ok === true,
      fetched: Number(result?.fetched) || 0,
      saved: Number(result?.saved) || 0,
      indexed: Number(result?.indexed) || 0,
      next: queuedNext,
    };

    await client.query(
      `
        UPDATE crawl_tasks
        SET
          status = 'done',
          result = $3::jsonb,
          locked_by = NULL,
          lock_token = NULL,
          locked_until = NULL,
          last_error = NULL,
          finished_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND lock_token = $2
      `,
      [id, lockToken, JSON.stringify(storedResult)],
    );

    await client.query('COMMIT');
    return { completed: true, queuedNext };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function failTask({
  id,
  lockToken,
  error,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query(
      `
        SELECT id, status, lock_token, attempts
        FROM crawl_tasks
        WHERE id = $1
        FOR UPDATE
      `,
      [id],
    );
    const current = row.rows[0];
    if (!current || current.status !== 'running' || current.lock_token !== lockToken) {
      await client.query('ROLLBACK');
      return { failed: false, reason: 'lost-lease' };
    }

    const attempts = Number(current.attempts) || 1;
    const dead = attempts >= Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
    const retryMs = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)),
    );

    await client.query(
      `
        UPDATE crawl_tasks
        SET
          status = $3::varchar,
          run_after = CASE
            WHEN $3::varchar = 'dead' THEN run_after
            ELSE NOW() + ($4::bigint * INTERVAL '1 millisecond')
          END,
          locked_by = NULL,
          lock_token = NULL,
          locked_until = NULL,
          last_error = $5,
          finished_at = CASE WHEN $3::varchar = 'dead' THEN NOW() ELSE NULL END,
          updated_at = NOW()
        WHERE id = $1
          AND lock_token = $2
      `,
      [
        id,
        lockToken,
        dead ? 'dead' : 'pending',
        retryMs,
        String(error || 'queue task failed').slice(0, 4000),
      ],
    );

    await client.query('COMMIT');
    return {
      failed: true,
      dead,
      attempts,
      retryMs: dead ? null : retryMs,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function queueStats() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
      COUNT(*) FILTER (WHERE status = 'running')::integer AS running,
      COUNT(*) FILTER (WHERE status = 'dead')::integer AS dead,
      COUNT(*) FILTER (WHERE status = 'done')::integer AS done,
      MIN(run_after) FILTER (WHERE status = 'pending') AS next_run_at
    FROM crawl_tasks
  `);
  return result.rows[0] || {
    pending: 0,
    running: 0,
    dead: 0,
    done: 0,
    next_run_at: null,
  };
}

export async function pruneQueueHistory(days = 7) {
  const keepDays = Math.max(1, Math.trunc(Number(days) || 7));
  const result = await pool.query(
    `
      DELETE FROM crawl_tasks
      WHERE status IN ('done', 'dead')
        AND finished_at < NOW() - ($1::integer * INTERVAL '1 day')
    `,
    [keepDays],
  );
  return result.rowCount;
}
