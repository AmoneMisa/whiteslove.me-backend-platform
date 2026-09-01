import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

const [candidateWriter, jobRefresh] = await Promise.all([
  read('../server/hiring/application/candidateSnapshotWriter.ts'),
  read('../server/utils/jobsSourceRefresh.ts'),
])

test('candidate snapshot rejects workshop/event promos instead of turning speakers into CVs', () => {
  assert.match(candidateWriter, /isCandidateEventPromotion/u)
  assert.match(candidateWriter, /воркшоп/u)
  assert.match(candidateWriter, /вебінар/u)
  assert.match(candidateWriter, /signals >= 2/u)
  assert.match(candidateWriter, /isRecruitingOpportunity\(text\) \|\| isCandidateEventPromotion\(text\)/u)
})

test('company names are removed from vacancy tags at the storage boundary', () => {
  assert.match(jobRefresh, /function cleanJobTags\(job: Job\)/u)
  assert.match(jobRefresh, /key === company/u)
  assert.match(jobRefresh, /sanitizeFetchedJob\(stored\)/u)
})
