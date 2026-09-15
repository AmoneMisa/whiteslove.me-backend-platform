import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeVacancyAi } from '../server/vacancies/application/vacancyAiEnricher.ts'

const base = {
  id: 'baseline', title: 'Developer', company: 'Example', location: 'Tashkent',
  url: 'https://example.test/baseline', source: 'telegram', remote: false,
  tags: [], postedAt: '2026-09-01T00:00:00.000Z', description: 'Backend developer', hiringKind: 'vacancy',
}
const cases = [
  { name: 'strong salary survives contradictory AI', facts: { salaryMin: 1000, salaryCurrency: 'USD' }, ai: { salaryMin: 2000, currency: 'EUR' }, expected: { salaryMin: 1000, salaryCurrency: 'USD' } },
  { name: 'explicit zero survives AI', facts: { experienceMinYears: 0 }, ai: { experienceMinYears: 5 }, expected: { experienceMinYears: 0 } },
  { name: 'missing salary receives enrichment', facts: {}, ai: { salaryMin: 1200 }, expected: { salaryMin: 1200 } },
  { name: 'invalid enum is rejected', facts: {}, ai: { seniority: 'ninja' }, expected: { seniority: undefined } },
]
for (const fixture of cases) {
  test(`parsing baseline: ${fixture.name}`, () => {
    const input = { ...base, ...fixture.facts }
    const before = structuredClone(input)
    const output = mergeVacancyAi(input, { status: 'completed', data: fixture.ai, confidence: .9 })
    for (const [field, expected] of Object.entries(fixture.expected)) assert.deepEqual(output[field], expected)
    assert.deepEqual(input, before)
  })
}
