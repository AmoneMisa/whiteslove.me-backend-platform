import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  RETENTION_POLICY_VERSION, retentionApproved, runSubscriptionRetention,
  UNSUBSCRIBED_GRACE_DAYS, PAUSED_INACTIVE_DAYS, DELIVERY_HISTORY_DAYS,
} from '../src/retention.mjs';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/edit_sessions/.test(sql)) return { rows: [{ sessions: 2, handoffs: 1 }] };
      return { rows: [], rowCount: /DELETE FROM subscriptions\.users/.test(sql) ? 3 : 5 };
    },
  };
}

test('the policy version matches the flats retention policy', async () => {
  const flats = await readFile(new URL('../../flats/src/privacy/retention-policy.js', import.meta.url), 'utf8');
  assert.match(flats, new RegExp(`RETENTION_POLICY_VERSION = '${RETENTION_POLICY_VERSION}'`));
});

test('without approval only expired one-time tokens are removed', async () => {
  const client = fakeClient();
  const report = await runSubscriptionRetention(client, 'subscriptions', { env: {} });
  assert.equal(client.calls.length, 1, 'no personal-data statement runs');
  assert.deepEqual(report, { approved: false, expiredSessions: 2, expiredHandoffs: 1, users: 0, deliveries: 0 });
  assert.equal(retentionApproved({ PRIVACY_RETENTION_POLICY_APPROVED: 'true' }), false, 'a generic yes is not approval');
});

test('with approval, unsubscribed and long-paused subscribers and old deliveries are deleted', async () => {
  const client = fakeClient();
  const report = await runSubscriptionRetention(client, 'subscriptions', {
    env: { PRIVACY_RETENTION_POLICY_APPROVED: RETENTION_POLICY_VERSION },
    batchSize: 50_000,
  });
  assert.equal(client.calls.length, 3);
  const [, users, deliveries] = client.calls;
  assert.deepEqual(users.params, [10_000, UNSUBSCRIBED_GRACE_DAYS, PAUSED_INACTIVE_DAYS], 'batch size is capped');
  assert.match(users.sql, /subs\.total = 0/);
  assert.match(users.sql, /subs\.total > 0 AND subs\.enabled = 0/, 'someone with an enabled subscription is never deleted');
  assert.deepEqual(deliveries.params, [10_000, DELIVERY_HISTORY_DAYS]);
  assert.match(deliveries.sql, /NOT EXISTS \(SELECT 1 FROM subscriptions\.users u/, 'deliveries of deleted users go too');
  assert.equal(report.users, 3);
  assert.equal(report.deliveries, 5);
});

test('an unsafe schema name is refused', async () => {
  await assert.rejects(() => runSubscriptionRetention(fakeClient(), 'x; DROP TABLE users', { env: {} }));
});

test('the bot runs retention on a timer', async () => {
  const index = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.match(index, /setInterval\(\(\) => void retentionTick\(\), 6 \* 60 \* 60_000\)/);
});
