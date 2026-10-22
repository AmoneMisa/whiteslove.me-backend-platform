import assert from 'node:assert/strict'
import test from 'node:test'
import { plausibleCandidateSalary } from '../server/utils/hiring/hiringNormalize.ts'
import { parseSalary } from '../shared/hiring/webFields.ts'

test('a desired salary that is really an age, a date or a placeholder is dropped', () => {
  assert.deepEqual(plausibleCandidateSalary({ salaryMin: 26, salaryMax: 26, currency: 'USD' }), {})
  assert.deepEqual(plausibleCandidateSalary({ salaryMin: 0, salaryMax: 0, currency: 'KZT' }), {})
  assert.deepEqual(plausibleCandidateSalary({ salaryMin: 950_515_240, salaryMax: 950_515_240, currency: 'USD' }), {})
  assert.deepEqual(plausibleCandidateSalary({ salaryMin: 1, salaryMax: 1, currency: 'UZS' }), {})
})

test('ordinary monthly wishes survive', () => {
  const salary = { salaryMin: 250_000, salaryMax: 400_000, currency: 'KZT' }
  assert.deepEqual(plausibleCandidateSalary(salary), salary)
  assert.deepEqual(plausibleCandidateSalary({ salaryMin: 2000, salaryMax: 2000, currency: 'USD' }), { salaryMin: 2000, salaryMax: 2000, currency: 'USD' })
})

test('a Kyrgyz card is read in som, not in Uzbek sum, and its age is not a salary', () => {
  const card = 'Инженер-строитель Бишкек\nМужчина, 39 лет\nБез опыта работы\nБишкек\n120 000 Сом\nНовое резюме'
  assert.deepEqual(parseSalary(card, 'KG'), { salaryMin: 120000, salaryMax: 120000, currency: 'KGS' })
  assert.deepEqual(parseSalary('Глава\n45 лет • Обновлено 26 августа\n2 000 $', 'UZ'), { salaryMin: 2000, salaryMax: 2000, currency: 'USD' })
})
