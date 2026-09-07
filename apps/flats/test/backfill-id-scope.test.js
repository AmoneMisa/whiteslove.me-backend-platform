import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeBackfillIds,
  parseBackfillIds,
} from '../src/maintenance/backfill-id-scope.js';

test('parses, canonicalizes and deduplicates PostgreSQL listing IDs', () => {
  const ids = parseBackfillIds(' 6965161,06714420,6965161, 8993401 ');
  assert.deepEqual(ids, ['6965161', '6714420', '8993401']);
  assert.equal(describeBackfillIds(ids), '6965161,6714420,8993401');
  assert.equal(describeBackfillIds(null), 'ALL');
});

test('rejects empty, non-positive, malformed and out-of-range IDs', () => {
  for (const value of ['', '0', '-1', '1.5', 'abc', '1,,2', '9223372036854775808']) {
    assert.throws(() => parseBackfillIds(value), /--ids/);
  }
});

test('caps a targeted maintenance run at 500 IDs', () => {
  const tooMany = Array.from({ length: 501 }, (_, index) => String(index + 1)).join(',');
  assert.throws(() => parseBackfillIds(tooMany), /at most 500/);
});
