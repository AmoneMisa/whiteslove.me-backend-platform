import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { buildSecondaryProfile } from '../server/hiring/sources/secondary/profile.ts'

test('secondary profile consumes shared parsers through the application adapter', () => {
  const profile = buildSecondaryProfile({
    key: 'novarobota-ua',
    country: 'UA',
    label: 'Test source',
    id: '1',
    role: 'Frontend Developer',
    activity: '2026-08-26T00:00:00.000Z',
    url: 'https://example.com/cv/1',
    text: 'Шукаю роботу Frontend Developer. Телефон: 095 082 01 03. Бажана зарплата 1200 CAD.',
    salaryCurrency: 'UAH',
  })

  assert.equal(profile.contacts?.phone, '+380950820103')
  assert.equal(profile.currency, 'CAD')
  assert.equal(profile.salaryMin, 1200)
  assert.equal(profile.salaryMax, 1200)
})

test('social hiring sources delegate contact parsing to shared adapters', async () => {
  const source = await readFile(new URL('../server/hiring/sources/socialRefresh.ts', import.meta.url), 'utf8')
  assert.match(source, /extractCandidateContacts\(text, country\)/u)
  assert.match(source, /contacts\(text, target\.country\)/u)
  assert.doesNotMatch(source, /const phone = text\.match/u)
  assert.doesNotMatch(source, /const telegram = text\.match/u)
})

test('IshBor profile delegates salary parsing instead of owning parser rules', async () => {
  const source = await readFile(new URL('../shared/hiring/ishBorProfile.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /const usd =/u)
  assert.doesNotMatch(source, /const millions =/u)
  assert.match(source, /sourceSalary\(`salary \$\{raw\}`\)/u)
})
