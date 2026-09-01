import assert from 'node:assert/strict'
import test from 'node:test'
import { WORK_UA_API_SOURCE } from '../server/hiring/sources/web/workUa.ts'

test('Work.ua API resume search maps public candidate cards through the shared web adapter', () => {
  const href = 'https://www.work.ua/resumes/17595762/'
  const profile = WORK_UA_API_SOURCE.parse({
    href,
    title: 'Manual QA Engineer (Web, API, Business Logic)',
    html: '<article>Manual QA Engineer</article>',
    text: 'Manual QA Engineer (Web, API, Business Logic) Kyiv Remote 19 years Full-time 1 hour ago',
  }, WORK_UA_API_SOURCE)

  assert.ok(profile)
  assert.equal(profile.sourceKey, 'workua-api')
  assert.equal(profile.origin, 'web')
  assert.equal(profile.country, 'UA')
  // The shared hiring normalizer deliberately keeps the canonical profession
  // while the source text remains available on the profile for matching/search.
  assert.equal(profile.role, 'Manual QA Engineer')
  assert.equal(profile.url, href)
  assert.equal(profile.contactType, 'platform')
  assert.equal(profile.contact, href)
  assert.equal(profile.age, 19)
  assert.equal(profile.remote, true)
})