import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  CANDIDATE_RETENTION_DAYS,
  RETENTION_POLICY_VERSION,
  purgeStaleCandidates,
  retentionApproved,
} from '../shared/privacy/candidateRetention.ts'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function fakeClient(counts) {
  const calls = []
  const queue = [...counts]
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: queue.length ? queue.shift() : 0 } } }
}

test('the policy version matches the flats retention policy', async () => {
  const flats = await readFile(new URL('../../flats/src/privacy/retention-policy.js', import.meta.url), 'utf8')
  assert.match(flats, new RegExp(`RETENTION_POLICY_VERSION = '${RETENTION_POLICY_VERSION}'`))
})

test('nothing is deleted without approval of this exact version', async () => {
  const client = fakeClient([])
  assert.deepEqual(await purgeStaleCandidates(client, 'hiring', { env: {} }), { approved: false, deleted: 0, batches: 0, exhausted: false })
  assert.equal(client.calls.length, 0)
  assert.equal(retentionApproved({ PRIVACY_RETENTION_POLICY_APPROVED: 'yes' }), false)
})

test('candidates not seen for six months are deleted in bounded batches', async () => {
  const client = fakeClient([2, 2, 1])
  const report = await purgeStaleCandidates(client, 'hiring', { env: { PRIVACY_RETENTION_POLICY_APPROVED: RETENTION_POLICY_VERSION }, batchSize: 2 })
  assert.deepEqual(report, { approved: true, deleted: 5, batches: 3, exhausted: false })
  assert.deepEqual(client.calls[0].params, [CANDIDATE_RETENTION_DAYS, 2])
  assert.equal(CANDIDATE_RETENTION_DAYS, 180)
  assert.match(client.calls[0].sql, /WHERE last_seen_at < NOW\(\) - make_interval\(days => \$1::int\)/)
})

test('a large backlog stops at the batch budget and continues next pass', async () => {
  const client = fakeClient(Array.from({ length: 10 }, () => 1000))
  const report = await purgeStaleCandidates(client, 'hiring', { env: { PRIVACY_RETENTION_POLICY_APPROVED: RETENTION_POLICY_VERSION }, maxBatches: 3 })
  assert.equal(report.batches, 3)
  assert.equal(report.exhausted, true)
})

test('an unsafe schema name is refused', async () => {
  await assert.rejects(() => purgeStaleCandidates(fakeClient([]), 'x; DROP TABLE y', { env: { PRIVACY_RETENTION_POLICY_APPROVED: RETENTION_POLICY_VERSION } }))
})

test('the cv worker runs retention and migration 003 indexes last_seen_at', async () => {
  const worker = await read('jobs-worker/worker.ts')
  const migration = await read('db/migrations/hiring/003_candidate_retention_index.sql')
  assert.match(worker, /WORKFORCE_DOMAIN === 'cv' && hiringDbEnabled\(\) && now - lastCandidateRetentionAt >= CANDIDATE_RETENTION_INTERVAL_MS/)
  assert.match(migration, /ON \{\{schema\}\}\.candidates \(last_seen_at\)/)
})
