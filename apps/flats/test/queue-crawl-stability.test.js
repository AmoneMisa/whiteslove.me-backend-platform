import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const queuePlan = readFileSync(new URL('../src/queuePlan.js', import.meta.url), 'utf8');
const queueTasks = readFileSync(new URL('../src/queueTasks.js', import.meta.url), 'utf8');
const queueDedup = readFileSync(new URL('../src/queueTaskDedup.js', import.meta.url), 'utf8');
const pgQueue = readFileSync(new URL('../src/pgQueue.js', import.meta.url), 'utf8');
const customQueue = readFileSync(new URL('../src/custom-source-queue.js', import.meta.url), 'utf8');
const listingRoutes = readFileSync(new URL('../src/listing-routes.js', import.meta.url), 'utf8');
const listingItemRoutes = readFileSync(new URL('../src/listing-item-routes.js', import.meta.url), 'utf8');
const queueMigration = readFileSync(new URL('../migrations/002_crawl_tasks.sql', import.meta.url), 'utf8');
const scheduler = readFileSync(new URL('../src/scheduler.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');

test('queue plan seeds one OLX page and lets successful tasks extend the chain', () => {
  assert.doesNotMatch(queuePlan, /page\s*<=\s*5/);
  assert.match(queuePlan, /page:\s*1/);
  assert.match(queueTasks, /pastCutoff/);
  assert.match(queueTasks, /rawCount\s*<=\s*0/);
  assert.match(queueTasks, /nextTasks:/);
  assert.match(queueTasks, /page:\s*nextPage/);
});

test('queue protocol v3 partitions stable crawl chains', () => {
  assert.match(queuePlan, /QUEUE_PROTOCOL_VERSION = Math\.max/);
  assert.match(queuePlan, /function stableHash/);
  assert.match(queuePlan, /function chainKey/);
  assert.match(queuePlan, /crawlerShard: crawlerShard\(task, shardCount\)/);
  assert.match(queuePlan, /crawlGeneration = randomUUID\(\)/);
  assert.match(queueTasks, /crawlerShard: task\.crawlerShard/);
  assert.match(queueTasks, /crawlGeneration: task\.crawlGeneration/);
});

test('PostgreSQL owns durable queue state, priority, leases and retries', () => {
  assert.match(queueMigration, /CREATE TABLE IF NOT EXISTS crawl_tasks/);
  assert.match(queueMigration, /status IN \('pending', 'running', 'done', 'dead'\)/);
  assert.match(queueMigration, /priority DESC/);
  assert.doesNotMatch(pgQueue, /CREATE TABLE IF NOT EXISTS crawl_tasks/);
  assert.doesNotMatch(pgQueue, /CREATE INDEX IF NOT EXISTS crawl_tasks_/);
  assert.doesNotMatch(pgQueue, /initCrawlQueueSchema/);
  assert.match(pgQueue, /FOR UPDATE SKIP LOCKED/);
  assert.match(pgQueue, /locked_until/);
  assert.match(pgQueue, /run_after/);
  assert.match(pgQueue, /ON CONFLICT \(task_key\) DO NOTHING/);
  assert.match(pgQueue, /pg_advisory_xact_lock/);
  assert.match(pgQueue, /RETRY_BASE_MS/);
  assert.match(pgQueue, /RETRY_MAX_MS/);
});

test('one Node worker owns dispatch, queue transitions and task execution directly', () => {
  assert.match(worker, /dispatchGenerationIfIdle/);
  assert.match(worker, /claimTask/);
  assert.match(worker, /claimCustomSourceTask/);
  assert.match(worker, /processQueueTask/);
  assert.match(worker, /completeTask/);
  assert.match(worker, /failTask/);
  assert.doesNotMatch(worker, /initCrawlQueueSchema/);
  assert.doesNotMatch(worker, /ensureListingSemantics/);
  assert.match(worker, /workerLoop\('telegram', 0\)/);
  assert.match(worker, /workerLoop\('custom', shard\)/);
  assert.doesNotMatch(worker, /\/internal\/queue-/);
  assert.doesNotMatch(compose, /(?:flat-finder|flats)-queue-task-api:/);
  assert.doesNotMatch(compose, /(?:flat-finder|flats)-queue-worker-/);
});

test('custom sources use the durable worker queue and never scrape in listing HTTP routes', () => {
  assert.match(customQueue, /type: 'flat\.custom\.url'/);
  assert.match(customQueue, /enqueueTasks\(tasks\)/);
  assert.match(customQueue, /FOR UPDATE SKIP LOCKED/);
  assert.match(queueTasks, /type === 'flat\.custom\.url'/);
  assert.match(queueTasks, /scrapeCustomUrl/);
  assert.doesNotMatch(listingRoutes, /getListings\(/);
  assert.doesNotMatch(listingRoutes, /scrapers\/custom/);
  assert.doesNotMatch(listingItemRoutes, /scrapers\/custom/);
  assert.match(listingItemRoutes, /validateCustomSource/);
});

test('on-demand custom tasks never delay the recurring crawl generation', () => {
  assert.ok(
    (pgQueue.match(/type <> 'flat\.custom\.url'/g) || []).length >= 2,
    'both recurring backlog and cadence queries must exclude custom jobs',
  );
});

test('compose gates API and worker on successful migrations', () => {
  assert.match(compose, /^\s{2}flats-migrate:\s*$/m);
  assert.match(compose, /command:\s*\["node",\s*"src\/migrate\.js"\]/);
  assert.ok(
    (compose.match(/condition:\s*service_completed_successfully/g) || []).length >= 2,
  );
  assert.doesNotMatch(compose, /DISABLE_SCHEDULER/);
});

test('OLX shards remain concurrent inside the isolated worker process', () => {
  assert.match(worker, /Array\.from\(\{length: QUEUE_SHARDS\}/);
  assert.match(worker, /workerLoop\('olx', shard\)/);
  assert.match(pgQueue, /type = 'flat\.olx\.page' AND crawler_shard = \$1/);
  assert.match(compose, /QUEUE_SHARDS:\s*\$\{FLATS_QUEUE_SHARDS:-2\}/);
});

test('successful completion enqueues chained OLX pages in the same Postgres transaction', () => {
  assert.match(pgQueue, /const nextTasks = Array\.isArray\(result\?\.nextTasks\)/);
  assert.match(pgQueue, /enqueueTasks\(nextTasks, client\)/);
  assert.match(pgQueue, /await client\.query\('COMMIT'\)/);
});

test('each OLX shard is pinned to a different fetcher', () => {
  assert.match(queueTasks, /OLX_FETCHER_URL_0/);
  assert.match(queueTasks, /OLX_FETCHER_URL_1/);
  assert.match(queueTasks, /function olxFetcherUrl/);
  assert.match(compose, /OLX_FETCHER_URL_0:\s*http:\/\/flats-olx-fetcher:4020/);
  assert.match(compose, /OLX_FETCHER_URL_1:\s*http:\/\/flats-olx-fetcher-ua:4020/);
});

test('task execution deduplication remains PostgreSQL-backed', () => {
  assert.match(queueTasks, /executeQueueTaskOnce/);
  assert.match(queueDedup, /crawl_task_runs/);
  assert.match(queueDedup, /ON CONFLICT \(task_key\)/);
  assert.match(queueDedup, /locked_until/);
  assert.match(queueDedup, /status = 'done'/);
  assert.match(queueDedup, /deduplicated: true/);
});

test('API refresh commands enqueue work and never execute crawlers directly', () => {
  assert.doesNotMatch(server, /startSocialHousingScheduler/);
  assert.doesNotMatch(server, /startScheduler/);
  assert.doesNotMatch(server, /warmCountry/);
  assert.match(scheduler, /dispatchGenerationIfIdle/);
  assert.match(scheduler, /buildCrawlPlan/);
  assert.doesNotMatch(scheduler, /startScheduler/);
  assert.doesNotMatch(scheduler, /warmCountry/);
  assert.doesNotMatch(scheduler, /scheduleCountryVision/);
  assert.match(worker, /startSocialHousingScheduler/);
  assert.match(worker, /refreshPlaces/);
});

test('RabbitMQ, Redis and HTTP queue proxy workers are absent', () => {
  assert.doesNotMatch(compose, /(?:flat-finder|flats)-rabbitmq:/);
  assert.doesNotMatch(compose, /(?:flat-finder|flats)-redis:/);
  assert.doesNotMatch(compose, /RABBITMQ_/);
  assert.doesNotMatch(compose, /REDIS_URL=/);
  assert.doesNotMatch(compose, /QUEUE_TASK_API_URL/);
  assert.doesNotMatch(compose, /(?:flat-finder|flats)-queue-dispatcher:/);
  assert.match(compose, /^\s{2}flats-worker:\s*$/m);
});
