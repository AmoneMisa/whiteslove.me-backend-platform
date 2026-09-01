import {createHash, randomUUID} from 'node:crypto';
import {pool} from './db.js';
import {enqueueTasks} from './infrastructure/queue/pgQueue.js';

const CACHE_BUCKET_MS = Math.max(
  60_000,
  Number(process.env.CUSTOM_SOURCE_CACHE_SECONDS || 300) * 1000,
);
const DEFAULT_WAIT_MS = Math.max(
  1_000,
  Number(process.env.CUSTOM_SOURCE_WAIT_MS) || 14_000,
);
const POLL_MS = Math.max(
  100,
  Number(process.env.CUSTOM_SOURCE_POLL_MS) || 200,
);
const LEASE_MS = Math.max(
  60_000,
  Number(process.env.QUEUE_TASK_LEASE_SECONDS || 300) * 1000,
);
const MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.QUEUE_MAX_ATTEMPTS) || 5,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonicalSourceUrl(raw) {
  const url = new URL(String(raw || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }
  url.hash = '';
  return url.href;
}

function sourceSegment(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

function generationFor(now = Date.now()) {
  return `custom:${Math.floor(now / CACHE_BUCKET_MS)}`;
}

function buildTasks(urls, countries, generation) {
  const tasks = [];
  for (const country of countries) {
    for (const url of urls) {
      tasks.push({
        type: 'flat.custom.url',
        country,
        url,
        segment: sourceSegment(url),
        priority: 20,
        queueProtocol: 4,
        crawlGeneration: generation,
        crawlerShard: 0,
      });
    }
  }
  return tasks;
}

async function customTaskRows(generation, countries, urls) {
  const result = await pool.query(
    `
      SELECT
        country,
        payload->>'url' AS url,
        status,
        result,
        last_error
      FROM crawl_tasks
      WHERE type = 'flat.custom.url'
        AND crawl_generation = $1
        AND country = ANY($2::text[])
        AND payload->>'url' = ANY($3::text[])
    `,
    [generation, countries, urls],
  );
  return result.rows;
}

export async function prepareCustomSources({
  urls,
  countries,
  waitMs = DEFAULT_WAIT_MS,
} = {}) {
  const normalizedUrls = [
    ...new Set((urls || []).map(canonicalSourceUrl)),
  ];
  const normalizedCountries = [
    ...new Set((countries || []).map((value) => String(value).toUpperCase()).filter(Boolean)),
  ];

  if (!normalizedUrls.length || !normalizedCountries.length) {
    return {warming: false, sourceErrors: [], rows: [], urls: normalizedUrls};
  }

  const generation = generationFor();
  const tasks = buildTasks(normalizedUrls, normalizedCountries, generation);
  await enqueueTasks(tasks);

  const expected = tasks.length;
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let rows = [];

  do {
    rows = await customTaskRows(generation, normalizedCountries, normalizedUrls);
    if (
      rows.length >= expected &&
      rows.every((row) => row.status === 'done' || row.status === 'dead')
    ) {
      break;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);

  const sourceErrors = rows
    .filter((row) => row.status === 'dead')
    .map((row) => ({
      source: 'custom',
      country: row.country,
      url: row.url,
      error: row.last_error || 'Custom source failed',
    }));
  const finished = rows.filter((row) => row.status === 'done' || row.status === 'dead').length;

  return {
    warming: finished < expected,
    sourceErrors,
    rows,
    urls: normalizedUrls,
  };
}

export async function validateCustomSource(url, country) {
  let normalized;
  try {
    normalized = canonicalSourceUrl(url);
  } catch (error) {
    return {ok: false, count: 0, error: error?.message || 'Invalid URL'};
  }

  const outcome = await prepareCustomSources({
    urls: [normalized],
    countries: [country],
    waitMs: Math.max(DEFAULT_WAIT_MS, 17_000),
  });
  const row = outcome.rows.find(
    (item) => item.country === String(country).toUpperCase() && item.url === normalized,
  );

  if (row?.status === 'done') {
    return {
      ok: true,
      count: Number(row.result?.fetched) || 0,
      error: null,
    };
  }
  if (row?.status === 'dead' || row?.last_error) {
    return {ok: false, count: 0, error: row.last_error || 'Custom source failed'};
  }
  return {ok: false, count: 0, error: 'Source validation is still processing'};
}

export async function claimCustomSourceTask({workerId, leaseMs = LEASE_MS} = {}) {
  const token = randomUUID();
  const worker = String(workerId || 'custom').slice(0, 200);
  const result = await pool.query(
    `
      WITH candidate AS (
        SELECT id
        FROM crawl_tasks
        WHERE status = 'pending'
          AND run_after <= NOW()
          AND attempts < $4
          AND type = 'flat.custom.url'
        ORDER BY priority DESC, run_after ASC, created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE crawl_tasks AS task
      SET
        status = 'running',
        attempts = task.attempts + 1,
        locked_by = $1,
        lock_token = $2,
        locked_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
        started_at = COALESCE(task.started_at, NOW()),
        updated_at = NOW()
      FROM candidate
      WHERE task.id = candidate.id
      RETURNING task.id, task.payload, task.attempts, task.priority,
                task.lock_token, task.locked_until
    `,
    [
      worker,
      token,
      Math.max(60_000, Number(leaseMs) || LEASE_MS),
      MAX_ATTEMPTS,
    ],
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