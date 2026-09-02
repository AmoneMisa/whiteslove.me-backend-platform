import assert from 'node:assert/strict'
import test from 'node:test'
import {
  USA_TECH_GREENHOUSE_COMPANIES,
  mapUsGreenhouseJobs,
} from '../server/utils/sources/usaTechCompanySources.ts'

test('US tech company catalog includes additional direct employers without UI sources', () => {
  const labels = new Set(USA_TECH_GREENHOUSE_COMPANIES.map((company) => company.label))
  for (const expected of [
    'Okta', 'Snowflake', 'DoorDash', 'PagerDuty', 'Rippling', 'Confluent',
    'dbt Labs', 'Fivetran', 'Retool', 'Intercom', 'Mercury', 'Hugging Face',
    'Character.AI', 'Yugabyte', 'ZoomInfo', 'Miro',
  ]) {
    assert.ok(labels.has(expected), `missing ${expected}`)
  }
})

test('Greenhouse mapper keeps US roles and rejects non-US roles', () => {
  const company = { handle: 'example', label: 'Example Tech' }
  const jobs = mapUsGreenhouseJobs(company, [
    {
      id: 101,
      title: 'Frontend Engineer',
      absolute_url: 'https://boards.greenhouse.io/example/jobs/101',
      updated_at: '2026-08-29T08:00:00Z',
      location: { name: 'New York, NY, United States' },
      departments: [{ name: 'Engineering' }],
      content: '<p>Build Vue and TypeScript interfaces.</p>',
    },
    {
      id: 102,
      title: 'Frontend Engineer',
      absolute_url: 'https://boards.greenhouse.io/example/jobs/102',
      updated_at: '2026-08-29T08:00:00Z',
      location: { name: 'London, United Kingdom' },
      content: '<p>Not a US vacancy.</p>',
    },
  ])

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].source, 'companies')
  assert.equal(jobs[0].company, 'Example Tech')
  assert.equal(jobs[0].location, 'New York, NY, United States')
  assert.equal(jobs[0].employerType, 'direct')
  assert.ok(jobs[0].tags.includes('USA'))
  assert.ok(jobs[0].tags.includes('Engineering'))
  assert.match(jobs[0].description || '', /Vue and TypeScript/)
})
