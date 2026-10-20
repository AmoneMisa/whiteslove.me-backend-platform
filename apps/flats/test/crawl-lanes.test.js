import test from 'node:test';
import assert from 'node:assert/strict';

import {buildCrawlPlan, CRAWL_LANES, taskLane} from '../src/scheduling/queuePlan.js';
import {customPageUrl, nextCustomPageTask} from '../src/scheduling/customPagination.js';

test('each crawl lane plans only its own task type and opens its own generation', () => {
  const plans = Object.fromEntries(
    CRAWL_LANES.map((lane) => [lane, buildCrawlPlan({shardCount: 2, lane})]),
  );

  for (const lane of CRAWL_LANES) {
    assert.ok(plans[lane].tasks.length > 0, `${lane} lane has tasks`);
    assert.ok(plans[lane].tasks.every((task) => taskLane(task) === lane));
  }
  assert.equal(new Set(CRAWL_LANES.map((lane) => plans[lane].crawlGeneration)).size, CRAWL_LANES.length);

  const all = buildCrawlPlan({shardCount: 2});
  assert.equal(
    all.tasks.length,
    CRAWL_LANES.reduce((sum, lane) => sum + plans[lane].tasks.length, 0),
  );
});

test('curated site tasks start at page 1 and are marked recurring', () => {
  const {tasks} = buildCrawlPlan({shardCount: 2, lane: 'custom'});
  assert.ok(tasks.every((task) => task.curated === true && task.page === 1));
});

test('custom page URLs keep page 1 untouched and add the page parameter afterwards', () => {
  const base = 'https://uybor.uz/listings?category__eq=7&operationType__eq=rent';
  assert.equal(customPageUrl(base, 1), base);
  assert.equal(customPageUrl(base, 3), `${base}&page=3`);
  assert.equal(customPageUrl('https://x.test/list', 2, 'p'), 'https://x.test/list?p=2');
});

test('custom pagination continues while pages bring new listings and stops on repeats', () => {
  const task = {type: 'flat.custom.url', curated: true, page: 1, priority: 6};
  const pageOne = [{url: 'https://x.test/1'}, {url: 'https://x.test/2'}];

  const second = nextCustomPageTask(task, 1, pageOne);
  assert.equal(second.page, 2);
  assert.deepEqual(second.pageKeys, ['https://x.test/1', 'https://x.test/2']);
  assert.equal(second.priority, 6);

  // Page 2 repeats page 1: the site ignores the parameter, so stop.
  assert.equal(nextCustomPageTask(second, 2, pageOne), null);

  // Page 2 brings something new: keep going.
  assert.equal(nextCustomPageTask(second, 2, [{url: 'https://x.test/3'}]).page, 3);

  // An empty page ends the chain.
  assert.equal(nextCustomPageTask(second, 2, []), null);
});

test('custom pagination respects a per-source page limit', () => {
  const task = {curated: true, page: 4, maxPages: 4, pageKeys: []};
  assert.equal(nextCustomPageTask(task, 4, [{url: 'https://x.test/9'}]), null);
});
