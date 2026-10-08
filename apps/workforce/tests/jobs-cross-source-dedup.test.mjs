import assert from 'node:assert/strict'
import test from 'node:test'

const { filterAndPaginate } = await import('../server/vacancies/domain/aggregate.ts')

const query = {
  sources: ['telegram', 'hh'], page: 1, pageSize: 50, sort: 'date', maxAgeDays: 14,
  cities: [], countries: [], skills: [], excludeLanguages: [],
}
const base = {
  company: 'Acme', location: 'Tashkent', remote: false, tags: [], postedAt: new Date().toISOString(),
  description: 'Vue developer',
}

test('aggregator repost collapses onto the original telegram channel', () => {
  const aggregator = { ...base, id: 'a', title: 'Vue Developer', url: 'https://t.me/revacancy/1', source: 'telegram', tags: ['@revacancy'] }
  const original = { ...base, id: 'b', title: 'Vue Developer', url: 'https://t.me/ayti_jobs/9', source: 'telegram', tags: ['@ayti_jobs'] }
  const result = filterAndPaginate([aggregator, original], query)
  assert.deepEqual(result.jobs.map((job) => job.url), ['https://t.me/ayti_jobs/9'])
})

test('a non-telegram posting wins over a telegram copy sharing its apply URL', () => {
  const copy = { ...base, id: 'a', company: 'Chan', title: 'Vue Dev', url: 'https://t.me/x/1', source: 'telegram', tags: ['@x'], applyUrl: 'https://acme.com/jobs/42' }
  const board = { ...base, id: 'b', title: 'Frontend', url: 'https://hh.uz/vacancy/42', source: 'hh', applyUrl: 'https://acme.com/jobs/42' }
  const result = filterAndPaginate([copy, board], query)
  assert.deepEqual(result.jobs.map((job) => job.source), ['hh'])
  assert.equal(result.sources.telegram, undefined)
})

test('distinct roles and bare careers pages are not merged', () => {
  const a = { ...base, id: 'a', title: 'Vue Developer', url: 'https://t.me/x/1', source: 'telegram', tags: ['@x'], applyUrl: 'https://acme.com/careers' }
  const b = { ...base, id: 'b', title: 'QA Engineer', url: 'https://t.me/y/2', source: 'telegram', tags: ['@y'], applyUrl: 'https://acme.com/careers' }
  assert.equal(filterAndPaginate([a, b], query).total, 2)
})
