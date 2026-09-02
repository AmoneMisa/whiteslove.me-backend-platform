import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

import {closeDb, pool} from '../src/infrastructure/database/listingRepository.js';
import {assertDatabaseReady} from '../src/infrastructure/database/schemaReady.js';
import {claimCustomSourceTask} from '../src/sources/custom-source-queue.js';
import {
  claimTask,
  completeTask,
  enqueueTasks,
  failTask,
} from '../src/infrastructure/queue/pgQueue.js';

const enabled = process.env.TEST_POSTGRES_SEARCH === '1';

test('PostgreSQL crawler queue claims by shard, retries and isolates custom workers', {skip: !enabled}, async () => {
  await assertDatabaseReady();

  const generation = `test-${randomUUID()}`;
  const pageOne = {
    type: 'flat.olx.page',
    country: 'UA',
    city: 'Odesa',
    citySlug: 'odessa',
    segment: 'flat:longRent',
    page: 1,
    priority: 10,
    queueProtocol: 3,
    crawlGeneration: generation,
    crawlerShard: 0,
  };

  try {
    await assert.rejects(
      () => enqueueTasks([{...pageOne, crawlGeneration: 'g'.repeat(129)}]),
      /queue crawlGeneration exceeds 128 characters/u,
    );
    await assert.rejects(
      () => enqueueTasks([{...pageOne, type: 't'.repeat(65)}]),
      /queue type exceeds 64 characters/u,
    );
    await assert.rejects(
      () => enqueueTasks([{...pageOne, country: 'C'.repeat(9)}]),
      /queue country exceeds 8 characters/u,
    );

    assert.equal(await enqueueTasks([pageOne, pageOne]), 1);

    const wrongShard = await claimTask({
      role: 'olx',
      shard: 1,
      workerId: 'test-worker-1',
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    assert.equal(wrongShard, null);

    const firstClaim = await claimTask({
      role: 'olx',
      shard: 0,
      workerId: 'test-worker-0',
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    assert.ok(firstClaim);
    assert.equal(firstClaim.payload.page, 1);
    assert.equal(firstClaim.attempts, 1);

    const failed = await failTask({
      id: firstClaim.id,
      lockToken: firstClaim.lockToken,
      error: 'synthetic failure',
      maxAttempts: 5,
    });
    assert.equal(failed.failed, true);
    assert.equal(failed.dead, false);
    assert.ok(failed.retryMs >= 5_000);

    const retryRow = await pool.query(
      `SELECT status, attempts, last_error FROM crawl_tasks WHERE id = $1`,
      [firstClaim.id],
    );
    assert.equal(retryRow.rows[0].status, 'pending');
    assert.equal(Number(retryRow.rows[0].attempts), 1);
    assert.equal(retryRow.rows[0].last_error, 'synthetic failure');

    // Avoid sleeping through the retry delay in an integration test.
    await pool.query(
      `UPDATE crawl_tasks SET run_after = NOW() WHERE id = $1`,
      [firstClaim.id],
    );

    const secondClaim = await claimTask({
      role: 'olx',
      shard: 0,
      workerId: 'test-worker-0',
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    assert.ok(secondClaim);
    assert.equal(secondClaim.attempts, 2);

    const pageTwo = {
      ...pageOne,
      page: 2,
      priority: 5,
    };
    const completed = await completeTask({
      id: secondClaim.id,
      lockToken: secondClaim.lockToken,
      result: {
        ok: true,
        fetched: 52,
        saved: 52,
        indexed: 52,
        nextTasks: [pageTwo, pageTwo],
      },
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.queuedNext, 1);

    const doneRow = await pool.query(
      `SELECT status, result FROM crawl_tasks WHERE id = $1`,
      [secondClaim.id],
    );
    assert.equal(doneRow.rows[0].status, 'done');
    assert.equal(Number(doneRow.rows[0].result.fetched), 52);

    const chained = await claimTask({
      role: 'olx',
      shard: 0,
      workerId: 'test-worker-0',
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    assert.ok(chained);
    assert.equal(chained.payload.page, 2);

    const chainedDone = await completeTask({
      id: chained.id,
      lockToken: chained.lockToken,
      result: {ok: true, fetched: 0, nextTasks: []},
    });
    assert.equal(chainedDone.completed, true);

    const customTask = {
      type: 'flat.custom.url',
      country: 'RO',
      url: 'https://example.com/feed.xml',
      segment: 'custom-test',
      priority: 20,
      queueProtocol: 4,
      crawlGeneration: generation,
      crawlerShard: 0,
    };
    assert.equal(await enqueueTasks([customTask, customTask]), 1);

    const regularWorkerMustIgnoreCustom = await claimTask({
      role: 'olx',
      shard: 0,
      workerId: 'test-worker-0',
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    assert.equal(regularWorkerMustIgnoreCustom, null);

    const customClaim = await claimCustomSourceTask({
      workerId: 'test-custom-worker',
      leaseMs: 60_000,
    });
    assert.ok(customClaim);
    assert.equal(customClaim.payload.type, 'flat.custom.url');
    assert.equal(customClaim.payload.url, customTask.url);

    const customDone = await completeTask({
      id: customClaim.id,
      lockToken: customClaim.lockToken,
      result: {ok: true, fetched: 3, saved: 3, indexed: 3, nextTasks: []},
    });
    assert.equal(customDone.completed, true);

    const customRow = await pool.query(
      `SELECT status, result FROM crawl_tasks WHERE id = $1`,
      [customClaim.id],
    );
    assert.equal(customRow.rows[0].status, 'done');
    assert.equal(Number(customRow.rows[0].result.fetched), 3);
  } finally {
    await pool.query(
      `DELETE FROM crawl_tasks WHERE crawl_generation = $1`,
      [generation],
    );
    await closeDb();
  }
});