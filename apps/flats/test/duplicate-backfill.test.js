import test from 'node:test';
import assert from 'node:assert/strict';
import { runDuplicateBackfillBatch } from '../src/maintenance/duplicate-backfill.js';

function client() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*WITH ranked/u.test(sql)) {
        return { rows: [{ id: '5', source: 'custom', country: 'UZ', source_id: 'owner-a', url: 'https://m2/obj/1', title: 'x' }] };
      }
      return { rowCount: 1, rows: [{ source: 'custom', country: 'UZ', source_id: 'owner-a' }] };
    },
  };
}

test('dry run only reports, it never updates', async () => {
  const c = client();
  const result = await runDuplicateBackfillBatch(c, {});
  assert.equal(result.found, 1);
  assert.equal(result.deactivated, 0);
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0].sql, /PARTITION BY data->>'url', MD5\(LEFT\(COALESCE\(description/u);
  assert.match(c.calls[0].sql, /source = 'custom'/u);
});

test('apply deactivates the older rows and removes them from the index', async () => {
  const c = client();
  const removed = [];
  const result = await runDuplicateBackfillBatch(c, { apply: true, removeFromIndex: async (docs) => removed.push(...docs) });
  assert.equal(result.deactivated, 1);
  assert.match(c.calls[1].sql, /duplicate_of_newer_row/u);
  assert.deepEqual(c.calls[1].params[0], ['5']);
  assert.deepEqual(removed, [{ source: 'custom', country: 'UZ', id: 'owner-a' }]);
});
