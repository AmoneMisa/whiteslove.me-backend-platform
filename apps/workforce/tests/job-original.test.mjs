import test from 'node:test'
import assert from 'node:assert/strict'
import {findProbableJobOriginal} from '../server/jobs/domain/jobOriginal.ts'

const NOW = new Date('2026-10-26T12:00:00Z')
const text = 'An independently published frontend role building accessible product interfaces with Vue and TypeScript. Work with the product team on shipping reliable features.'
const pair = () => [
  {identity_key: 'companies:1', public_id: 1, data: {id: '1', source: 'companies', employerType: 'direct',
    company: 'Acme LLC', title: 'Frontend Engineer', description: text, url: 'https://acme.example/careers/frontend', postedAt: '2026-10-10'}},
  {identity_key: 'hh:2', public_id: 2, data: {id: '2', source: 'hh', employerType: 'board',
    company: 'Acme', title: 'Frontend Engineer', description: text, url: 'https://hh.ru/vacancy/2',
    applyUrl: 'https://acme.example/careers/frontend', postedAt: '2026-10-20'}},
]
const find = rows => findProbableJobOriginal(rows, NOW)

test('a company posting linked by another board with matching content is an explained candidate', () => {
  const result = find(pair())
  assert.equal(result.candidatePublicId, 1)
  assert.equal(result.confidence, 'moderate')
  assert.ok(result.evidence.includes('shared_application_page'))
  assert.equal(result.ownershipVerified, false)
})

test('role matches, agency claims, generic homepage links and differing content do not identify the original', () => {
  for (const change of [
    rows => {rows[0].data.source = 'hh'},
    rows => {rows[0].data.employerType = 'agency'},
    rows => {rows[1].data.applyUrl = 'https://other.example/careers/frontend'},
    rows => {rows[0].data.url = rows[1].data.applyUrl = 'https://acme.example/'},
    rows => {rows[1].data.description = 'A different opening'},
    rows => {rows[1].data.title = 'Senior Frontend Engineer'},
  ]) {
    const rows = pair(); change(rows)
    assert.equal(find(rows).candidatePublicId, null)
  }
})

test('application query parameters identifying different openings are preserved', () => {
  const rows = pair()
  rows[0].data.url = 'https://acme.example/careers?id=one'
  rows[1].data.applyUrl = 'https://acme.example/careers?id=two'
  assert.equal(find(rows).status, 'insufficient_evidence')
})

test('two company-source candidates are ambiguous rather than ranked by observation date', () => {
  const rows = pair()
  const second = pair()
  second[0].public_id = 3
  second[0].identity_key = 'companies:3'
  second[0].data.url = second[1].data.applyUrl = 'https://acme.example/careers/frontend-two'
  second[1].public_id = 4
  second[1].identity_key = 'hh:4'
  assert.equal(find([...rows, ...second]).status, 'ambiguous')
})

test('crawl-time fallbacks and date refreshes do not pretend to be chronology evidence', () => {
  const rows = pair()
  rows[0].first_seen_at = '2026-09-01'
  rows[1].data.postedAt = '2026-08-01'
  assert.equal(find(rows).candidatePublicId, 1)
  assert.ok(!find(rows).evidence.includes('earlier_source_date'))
  rows[0].data.postedAt = null
  assert.equal(find(rows).candidatePublicId, 1)
})
