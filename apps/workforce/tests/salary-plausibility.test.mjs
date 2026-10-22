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
})

test('amounts that are not a wage at all have no salary', () => {
  assert.equal(annualSalaryUsd(3, 'year', 'USD'), undefined)
  assert.equal(annualSalaryUsd(7_100_000_000, 'year', 'USD'), undefined)
  assert.equal(annualSalaryUsd(0, 'month', 'USD'), undefined)
  assert.equal(annualSalaryUsd(undefined, 'month', 'USD'), undefined)
  assert.equal(annualSalaryUsd(20, 'month', 'KZT'), undefined)
})
