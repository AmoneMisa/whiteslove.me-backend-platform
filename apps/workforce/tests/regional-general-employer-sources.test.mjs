import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REGIONAL_GENERAL_EMPLOYERS,
  parseRegionalEmployerPage,
} from '../server/utils/regionalGeneralEmployerSources.ts'

test('general employer catalog covers Ukraine, Romania and Uzbekistan', () => {
  const countries = new Set(REGIONAL_GENERAL_EMPLOYERS.map((employer) => employer.country))
  assert.deepEqual([...countries].sort(), ['RO', 'UA', 'UZ'])
  assert.ok(REGIONAL_GENERAL_EMPLOYERS.length >= 8)
})

test('JSON-LD job postings map as direct company jobs', () => {
  const employer = REGIONAL_GENERAL_EMPLOYERS.find((item) => item.label === 'Sense Bank')
  assert.ok(employer)

  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title: 'Contact Center Specialist',
    url: 'https://sensebank.ua/vacancies/contact-center-specialist',
    datePosted: '2026-08-28',
    employmentType: 'FULL_TIME',
    hiringOrganization: { name: 'Sense Bank' },
    jobLocation: { address: { addressLocality: 'Kyiv', addressCountry: 'UA' } },
    description: '<p>Customer service and banking operations</p>',
  })}</script>`

  const jobs = parseRegionalEmployerPage(html, employer)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].company, 'Sense Bank')
  assert.equal(jobs[0].source, 'companies')
  assert.equal(jobs[0].employerType, 'direct')
  assert.match(jobs[0].location, /Kyiv/)
})

test('anchor fallback accepts vacancy detail links and rejects navigation', () => {
  const employer = REGIONAL_GENERAL_EMPLOYERS.find((item) => item.label === 'Korzinka')
  assert.ok(employer)

  const jobs = parseRegionalEmployerPage(`
    <a href="/vacancies/">Вакансии</a>
    <a href="/vacancies/cashier-tashkent">Старший кассир</a>
    <a href="/about">О компании</a>
  `, employer)

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].title, 'Старший кассир')
  assert.equal(jobs[0].company, 'Korzinka')
})
