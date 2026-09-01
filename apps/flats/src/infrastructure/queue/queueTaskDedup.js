import {randomUUID} from 'node:crypto';
import {pool} from '../../db.js';

const RUNNING_TTL_MS = Math.max(
  30_000,
  Number(process.env.QUEUE_TASK_RUNNING_TTL_MS) || 90_000,
);
const DONE_TTL_MS = Math.max(
  RUNNING_TTL_MS,
  Number(process.env.QUEUE_TASK_DONE_TTL_MS) || 24 * 60 * 60_000,
);
const RENEW_INTERVAL_MS = Math.max(10_000, Math.floor(RUNNING_TTL_MS / 3));
const CLEANUP_INTERVAL_MS = 30 * 60_000;

let lastCleanupAt = 0;

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

async function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  const retentionMs = Math.max(DONE_TTL_MS * 2, 48 * 60 * 60_000);
  await pool.query(
    `DELETE FROM crawl_task_runs WHERE updated_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')`,
    [retentionMs],
  );
}

async function acquireTask(task, token) {
  const key = taskIdentity(task);
  const generation = String(task.crawlGeneration || 'legacy');
  const result = await pool.query(
    `
      INSERT INTO crawl_task_runs (
        task_key,
        crawl_generation,
        status,
        lock_token,
        locked_until,
        result,
        updated_at,
        finished_at
      )
      VALUES (
        $1,
        $2,
        'running',
        $3::uuid,
        NOW() + ($4::double precision * INTERVAL '1 millisecond'),
        NULL,
        NOW(),
        NULL
      )
      ON CONFLICT (task_key)
      DO UPDATE SET
        crawl_generation = EXCLUDED.crawl_generation,
        status = 'running',
        lock_token = EXCLUDED.lock_token,
        locked_until = EXCLUDED.locked_until,
        result = NULL,
        updated_at = NOW(),
        finished_at = NULL
      WHERE
        crawl_task_runs.status <> 'done'
        AND (
          crawl_task_runs.locked_until IS NULL
          OR crawl_task_runs.locked_until <= NOW()
        )
      RETURNING task_key
    `,
    [key, generation, token, RUNNING_TTL_MS],
  );
  return result.rowCount > 0;
}

async function readExisting(task) {
  const result = await pool.query(
    `SELECT status, result, locked_until FROM crawl_task_runs WHERE task_key = $1`,
    [taskIdentity(task)],
  );
  return result.rows[0] || null;
}

async function renewTask(task, token) {
  await pool.query(
    `
      UPDATE crawl_task_runs
      SET
        locked_until = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE task_key = $1 AND status = 'running' AND lock_token = $2::uuid
    `,
    [taskIdentity(task), token, RUNNING_TTL_MS],
  );
}

async function finishTask(task, token, result) {
  const updated = await pool.query(
    `
      UPDATE crawl_task_runs
      SET
        status = 'done',
        result = $3::jsonb,
        lock_token = NULL,
        locked_until = NULL,
        updated_at = NOW(),
        finished_at = NOW()
      WHERE task_key = $1 AND status = 'running' AND lock_token = $2::uuid
      RETURNING task_key
    `,
    [taskIdentity(task), token, JSON.stringify(result)],
  );
  return updated.rowCount > 0;
}

async function releaseTask(task, token) {
  await pool.query(
    `DELETE FROM crawl_task_runs WHERE task_key = $1 AND status = 'running' AND lock_token = $2::uuid`,
    [taskIdentity(task), token],
  );
}

export async function executeQueueTaskOnce(task, execute) {
  // crawl_task_runs is owned by migration 004. Runtime code only mutates data.
  maybeCleanup().catch((error) => {
    console.warn('[queue-dedup] cleanup failed:', error.message);
  });

  const token = randomUUID();
  const acquired = await acquireTask(task, token);
  if (!acquired) {
    const existing = await readExisting(task);
    if (existing?.status === 'done' && existing.result) {
      return {
        ...existing.result,
        deduplicated: true,
      };
    }
    throw new Error(`queue task already running: ${taskIdentity(task)}`);
  }

  const renewTimer = setInterval(() => {
    renewTask(task, token).catch((error) => {
      console.warn('[queue-dedup] lock refresh failed:', error.message);
    });
  }, RENEW_INTERVAL_MS);
  renewTimer.unref?.();

  try {
    const result = await execute();
    const finished = await finishTask(task, token, result);
    if (!finished) {
      throw new Error(`queue task lost dedup lock: ${taskIdentity(task)}`);
    }
    return result;
  } catch (error) {
    try {
      await releaseTask(task, token);
    } catch {}
    throw error;
  } finally {
    clearInterval(renewTimer);
  }
}

// Uses the shared database pool; lifecycle is owned by closeDb().
export async function closeQueueTaskDedup() {}
