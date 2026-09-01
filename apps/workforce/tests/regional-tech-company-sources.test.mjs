import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REGIONAL_TECH_COMPANIES,
  mapRegionalLeverPostings,
  mapRegionalSmartRecruitersPostings,
} from '../server/utils/regionalTechCompanySources.ts'

const posting = (location, title = 'Frontend Engineer') => ({
  id: `${location}-${title}`,
  text: title,
  hostedUrl: `https://jobs.lever.co/example/${encodeURIComponent(location)}-${encodeURIComponent(title)}`,
  createdAt: Date.now(),
  descriptionPlain: 'Vue TypeScript product engineering role',
  categories: { location, team: 'Engineering', commitment: 'Full-time' },
  workplaceType: 'remote',
})

test('regional source catalog covers Ukraine, Romania and Uzbekistan', () => {
  const countries = new Set(REGIONAL_TECH_COMPANIES.map((company) => company.country))
  assert.deepEqual([...countries].sort(), ['RO', 'UA', 'UZ'])
  assert.ok(REGIONAL_TECH_COMPANIES.length >= 14)
})

test('Ukraine company mapping keeps Ukraine jobs and rejects unrelated countries', () => {
  const company = REGIONAL_TECH_COMPANIES.find((item) => item.handle === 'provectus')
  assert.ok(company)
  const jobs = mapRegionalLeverPostings([
    posting('Ukraine'),
    posting('Poland', 'Backend Engineer'),
  ], company)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].location, 'Ukraine')
  assert.equal(jobs[0].source, 'companies')
  assert.equal(jobs[0].employerType, 'direct')
})

test('Romania and Uzbekistan aliases match city-level Lever locations', () => {
  const romania = REGIONAL_TECH_COMPANIES.find((item) => item.handle === '3pillarglobal')
  const uzbekistan = REGIONAL_TECH_COMPANIES.find((item) => item.handle === 'binance')
  assert.ok(romania)
  assert.ok(uzbekistan)

  assert.equal(mapRegionalLeverPostings([posting('Bucharest, Romania')], romania).length, 1)
  assert.equal(mapRegionalLeverPostings([posting('Uzbekistan, Tashkent')], uzbekistan).length, 1)
  assert.equal(mapRegionalLeverPostings([posting('Dubai')], uzbekistan).length, 0)
})

test('SmartRecruiters regional mapping filters by the requested country', () => {
  const company = REGIONAL_TECH_COMPANIES.find((item) => item.handle === 'Endava' && item.country === 'RO')
  assert.ok(company)

  const jobs = mapRegionalSmartRecruitersPostings([
    {
      id: 'ro-1',
      name: 'Service Delivery Manager',
      releasedDate: '2026-08-28T00:00:00Z',
      location: { fullLocation: 'Bucharest, Romania' },
      function: { label: 'Delivery' },
      typeOfEmployment: { label: 'Full-time' },
    },
    {
      id: 'uk-1',
      name: 'Project Manager',
      location: { fullLocation: 'London, United Kingdom' },
    },
  ], company)

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].company, 'Endava')
  assert.equal(jobs[0].source, 'companies')
})
