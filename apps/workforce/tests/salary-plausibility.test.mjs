import assert from 'node:assert/strict'
import test from 'node:test'
import { annualSalaryUsd } from '../server/vacancies/domain/salaryPlausibility.ts'

test('a normal period converts to an annual figure', () => {
  assert.deepEqual(annualSalaryUsd(3000, 'month', 'USD'), { usd: 36000, period: 'month' })
  assert.deepEqual(annualSalaryUsd(95000, 'year', 'USD'), { usd: 95000, period: 'year' })
  assert.deepEqual(annualSalaryUsd(30, 'hour', 'USD'), { usd: 57600, period: 'hour' })
})

test('a yearly amount labelled monthly is not multiplied by twelve', () => {
  // "100 000 – 167 000 USD / month" on a remote board is a yearly pay.
  assert.deepEqual(annualSalaryUsd(133500, 'month', 'USD'), { usd: 133500, period: 'year' })
})

test('a small yearly amount is an hourly wage in dollars and a monthly one in a local currency', () => {
  assert.deepEqual(annualSalaryUsd(16, 'year', 'USD'), { usd: 30720, period: 'hour' })
  assert.deepEqual(annualSalaryUsd(240, 'year', 'KZT'), { usd: 2880, period: 'month' })
  assert.deepEqual(annualSalaryUsd(428, 'year', 'KZT'), { usd: 5136, period: 'month' })
  assert.deepEqual(annualSalaryUsd(60000, 'year', 'KZT'), { usd: 60000, period: 'year' })
})

test('amounts that are not a wage at all have no salary', () => {
  assert.equal(annualSalaryUsd(3, 'year', 'USD'), undefined)
  assert.equal(annualSalaryUsd(7_100_000_000, 'year', 'USD'), undefined)
  assert.equal(annualSalaryUsd(0, 'month', 'USD'), undefined)
  assert.equal(annualSalaryUsd(undefined, 'month', 'USD'), undefined)
  assert.equal(annualSalaryUsd(20, 'month', 'KZT'), undefined)
})

test('a range with a mistyped top uses the bottom', async () => {
  const { annualSalary } = await import('../server/vacancies/domain/enrich.ts')
  const job = { salaryMin: 100000, salaryMax: 80000000, salaryCurrency: 'USD' }
  assert.equal(annualSalary(job, 'year')?.usd, 100000)
  assert.equal(annualSalary({ ...job, salaryMax: 120000 }, 'year')?.usd, 110000)
  assert.equal(annualSalary({ salaryMin: 5, salaryMax: 77098, salaryCurrency: 'USD' }, 'year')?.usd, 77098)
})

test('re-enriching a stored hh job does not turn its monthly pay back into a yearly one', async () => {
  const { enrichJob } = await import('../server/vacancies/domain/enrich.ts')
  const job = {
    id: '138359638', source: 'hh', title: 'Бухгалтер', company: 'ТОО Тест', location: 'Алматы', country: 'KZ',
    url: 'https://hh.kz/vacancy/138359638', postedAt: new Date().toISOString(), description: 'Работа в офисе', tags: [],
    salaryMin: 400000, salaryMax: 600000, salaryCurrency: 'KZT', salaryPeriod: 'year',
  }
  const once = enrichJob(job)
  assert.equal(once.salaryPeriod, 'month')
  assert.ok(once.salaryUsd > 8000 && once.salaryUsd < 20000, String(once.salaryUsd))
  assert.equal(enrichJob(once).salaryUsd, once.salaryUsd)
})
