import assert from 'node:assert/strict'
import test from 'node:test'
import {readJobActivity} from '../server/jobs/infrastructure/database.ts'
import {groupJobPostings} from '../server/jobs/domain/jobActivity.ts'

test('job history preserves cursor precision and does not call a date update a repost', async () => {
  const calls = []
  const client = {query: async (text, values) => {
    calls.push({text, values})
    return calls.length === 1
      ? {rows: [{identity_key: 'hh:one', cluster_key: 'role', first_seen_at: '2026-10-01'}]}
      : {rows: [{id: '9007199254740995', kind: 'date_updated', observed_at: '2026-10-26', source_published_at: '2026-10-25'}]}
  }}
  const result = await readJobActivity(client, 'jobs', '101', 'history', '9007199254740996')
  assert.equal(result.events[0].kind, 'date_updated')
  assert.equal(result.events[0].sourcePublishedAt, '2026-10-25')
  assert.equal(calls[1].values[1], '9007199254740996')
})

test('job cluster matches remain role candidates and include inactive original postings', async () => {
  let call = 0
  const client = {query: async () => ++call === 1
    ? {rows: [{identity_key: 'hh:one', cluster_key: 'role'}]}
    : {rows: [
      {identity_key: 'hh:one', public_id: 101, active: true, data: {id: 'one', source: 'hh', employerType: 'direct'}},
      {identity_key: 'work:two', public_id: 102, active: false, data: {id: 'two', source: 'work', employerType: 'agency'}},
    ]}}
  const result = await readJobActivity(client, 'jobs', '101', 'duplicates')
  assert.equal(result.duplicateCount, 1)
  assert.equal(result.groups.length, 2, 'direct employer and agency stay separate')
  assert.equal(result.groups[0].listings[0].current, true)
  assert.equal(result.groups[1].listings[0].matchKind, 'same_role')
  assert.equal(result.groups[1].listings[0].active, false)
  assert.equal(result.groups[1].listings[0].advertiserType, 'agency')
  assert.ok(result.groups.every(g => g.sameAdvertiser === false), 'role matches do not prove shared recruiter identity')
})

test('publisher comparison preserves salary terms and does not merge unknown recruiters', () => {
  const row = (id, employerType, salaryMin = 1000) => ({identity_key: `hh:${id}`, public_id: id, active: true,
    first_seen_at: '2026-10-26', data: {id, source: 'hh', company: 'Acme', employerType,
      salaryMin, salaryMax: 2000, salaryCurrency: 'USD', salaryPeriod: 'month', salaryGross: false,
      applyUrl: 'https://acme.example/jobs/1'}})
  const groups = groupJobPostings([row(1, 'direct'), row(2, 'direct'), row(3, 'agency'), row(4), row(5)], 'hh:1')
  assert.deepEqual(groups.map(g => g.listings.length), [2, 1, 1, 1])
  const posting = groups[0].listings[0]
  assert.equal(posting.salary.min, 1000)
  assert.equal(posting.salary.period, 'month')
  assert.equal(posting.salary.gross, false)
  assert.equal(posting.applyUrl, 'https://acme.example/jobs/1')
})

test('activity lookup returns missing instead of inventing history and validates schema names', async () => {
  const client = {query: async () => ({rows: []})}
  assert.equal(await readJobActivity(client, 'jobs', '404', 'history'), null)
  await assert.rejects(() => readJobActivity(client, 'jobs; DROP TABLE jobs', '101', 'history'), /Invalid schema/)
})
