import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {LIST_LIMITS, cleanDomain, normalizeListOp, normalizeListOps} from '../src/mobile/mobile-lists.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('only the jobs and cv domains exist', () => {
  assert.equal(cleanDomain('jobs'), 'jobs');
  assert.equal(cleanDomain('cv'), 'cv');
  for (const value of ['flats', '', 'JOBS', '../jobs', null]) assert.equal(cleanDomain(value), null);
});

test('list operations are validated one by one', () => {
  assert.deepEqual(normalizeListOp({op: 'put', list: 'favorites', key: 'hh:123', payload: {title: 'Dev'}}),
    {op: 'put', list: 'favorites', key: 'hh:123', payload: '{"title":"Dev"}'});
  assert.deepEqual(normalizeListOp({op: 'add', list: 'seen', key: 'hh:1'}), {op: 'add', list: 'seen', key: 'hh:1', payload: '{}'});
  assert.deepEqual(normalizeListOp({op: 'delete', list: 'hidden', key: 'x'}), {op: 'delete', list: 'hidden', key: 'x'});
  assert.deepEqual(normalizeListOp({op: 'clear', list: 'recent'}), {op: 'clear', list: 'recent'});
  // Unknown lists and ops, control characters, arrays and oversized payloads.
  assert.equal(normalizeListOp({op: 'put', list: 'sorted', key: 'x'}), null);
  assert.equal(normalizeListOp({op: 'drop', list: 'favorites', key: 'x'}), null);
  assert.equal(normalizeListOp({op: 'put', list: 'favorites', key: 'a\u0000b'}), null);
  assert.equal(normalizeListOp({op: 'put', list: 'favorites', key: 'x', payload: [1]}), null);
  assert.equal(normalizeListOp({op: 'put', list: 'favorites', key: 'x', payload: {text: 'a'.repeat(70 * 1024)}}), null);
});

test('a batch is all valid or rejected, and bounded', () => {
  assert.equal(normalizeListOps({ops: [{op: 'clear', list: 'seen'}]}).length, 1);
  for (const body of [{}, {ops: []}, {ops: [{op: 'clear', list: 'seen'}, {op: 'nope'}]}, {ops: Array(201).fill({op: 'clear', list: 'seen'})}]) {
    assert.throws(() => normalizeListOps(body), (error) => error.statusCode === 400);
  }
});

test('lists are windows and every write trims them', async () => {
  assert.deepEqual(Object.keys(LIST_LIMITS), ['favorites', 'hidden', 'recent', 'seen', 'presets']);
  const source = await read('src/mobile/mobile-lists.js');
  assert.match(source, /await trimLists\(client, deviceId, domain\);\s+await client\.query\('COMMIT'\);/u);
  // Reads and writes go through the account once linked.
  assert.equal((source.match(/const deviceId = await ensureInstallation\(client, credentials\);/gu) || []).length, 2);
  // `add` never overwrites: that is what makes merging a browser's copy safe.
  assert.match(source, /item\.op === 'put'\s+\? 'DO UPDATE SET payload = EXCLUDED\.payload, updated_at = NOW\(\)'\s+: 'DO NOTHING'/u);
});

test('the table follows its installation and the account lifecycle', async () => {
  const migration = await read('migrations/060_user_saved_lists.sql');
  assert.match(migration, /REFERENCES user_data\.installations\(device_id\) ON DELETE CASCADE/u);
  assert.match(migration, /CHECK \(domain IN \('jobs', 'cv'\)\)/u);
  const account = await read('src/mobile/mobile-account.js');
  assert.match(account, /DELETE FROM \$\{SCHEMA\}\.saved_list_items WHERE device_id = \$1/u);
  assert.match(account, /await trimLists\(client, accountOwner\);/u);
  const app = await read('src/app.js');
  assert.match(app, /registerMobileListRoutes\(app\);/u);
  assert.match(app, /app\.use\('\/api\/mobile\/lists', express\.json\(\{limit: '1mb'\}\)\);/u);
});
