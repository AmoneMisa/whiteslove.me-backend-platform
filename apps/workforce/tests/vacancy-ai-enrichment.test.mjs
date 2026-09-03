import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VACANCY_PARSER_VERSION,
  mergeVacancyAi,
  needsVacancyAi,
  vacancyAiInput,
} from '../server/vacancies/application/vacancyAiEnricher.ts'

function job(extra = {}) {
  return {
    id: 'job-1',
    title: 'Backend developer',
    company: 'Acme',
    location: 'Tashkent',
    url: 'https://example.test/1',
    source: 'telegram',
    remote: false,
    tags: [],
    postedAt: '2026-09-01T00:00:00.000Z',
    description: 'Ищем backend разработчика, график 5/2, нужен английский',
    hiringKind: 'vacancy',
    ...extra,
  }
}

function result(data, confidence = 0.9) {
  return { status: 'completed', data, confidence }
}

test('the deterministic parse is never overwritten by the model', () => {
  const merged = mergeVacancyAi(
    job({ salaryMin: 1000, salaryCurrency: 'USD', seniority: 'senior' }),
    result({ salaryMin: 9999, currency: 'EUR', seniority: 'junior' }),
  )

  assert.equal(merged.salaryMin, 1000)
  assert.equal(merged.salaryCurrency, 'USD')
  assert.equal(merged.seniority, 'senior')
  assert.deepEqual(merged.ai.derivedFields, [])
})

test('only empty fields are filled, and they are recorded', () => {
  const merged = mergeVacancyAi(job(), result({
    salaryMin: 1200,
    salaryMax: 2000,
    schedule: '5/2',
    seniority: 'middle',
    skills: ['Node.js', 'PostgreSQL', ' Node.js '],
  }))

  assert.equal(merged.salaryMin, 1200)
  assert.equal(merged.salaryMax, 2000)
  assert.equal(merged.schedule, '5/2')
  assert.equal(merged.seniority, 'middle')
  assert.deepEqual(merged.skills, ['Node.js', 'PostgreSQL'])
  assert.deepEqual(merged.ai.derivedFields, ['salaryMax', 'salaryMin', 'schedule', 'seniority', 'skills'])
  assert.equal(merged.ai.parserVersion, VACANCY_PARSER_VERSION)
})

test('a value outside the contract enum is refused', () => {
  const merged = mergeVacancyAi(job(), result({
    seniority: 'ninja',
    salaryPeriod: 'fortnight',
    workFormat: 'field',
  }))

  assert.equal(merged.seniority, undefined)
  assert.equal(merged.salaryPeriod, undefined)
  assert.equal(merged.workMode, undefined)
  assert.deepEqual(merged.ai.derivedFields, [])
})

test('language requirements are mapped onto the contract shape', () => {
  const merged = mergeVacancyAi(job(), result({
    languages: [
      { language: 'English', level: 'B2', required: true },
      { language: 'Uzbek', level: null, required: false },
      { language: '  ', level: 'A1', required: true },
    ],
  }))

  assert.deepEqual(merged.languages, [
    { language: 'English', level: 'B2', requirement: 'required' },
    { language: 'Uzbek', requirement: 'notRequired' },
  ])
})

test('relocation and work mode map to contract values', () => {
  const offered = mergeVacancyAi(job(), result({ relocationSupport: true, workFormat: 'hybrid' }))
  assert.equal(offered.relocation, 'offered')
  assert.equal(offered.workMode, 'hybrid')

  const none = mergeVacancyAi(job(), result({ relocationSupport: false }))
  assert.equal(none.relocation, 'none')
})

test('non-vacancy posts never spend inference budget', () => {
  assert.equal(needsVacancyAi(job({ hiringKind: 'course' })), false)
  assert.equal(needsVacancyAi(job({ hiringKind: 'vacancy_digest' })), false)
  assert.equal(needsVacancyAi(job({ description: '', title: '' })), false)
  assert.equal(needsVacancyAi(job()), true)
})

test('the fingerprint changes when the deterministic facts change', () => {
  const before = vacancyAiInput(job()).fingerprint
  const after = vacancyAiInput(job({ salaryMin: 1000 })).fingerprint
  const sameAgain = vacancyAiInput(job()).fingerprint

  assert.notEqual(before, after)
  assert.equal(before, sameAgain)
})
