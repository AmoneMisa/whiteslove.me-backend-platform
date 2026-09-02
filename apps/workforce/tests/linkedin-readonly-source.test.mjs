import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildLinkedInSearchParams,
  parseLinkedInJobCards,
  parseLinkedInJobAvailability,
  parseLinkedInJobDetail,
} from '../server/utils/sources/linkedinSource.ts'
import { linkedinVoyagerConfigured } from '../server/hiring/sources/linkedinVoyager.ts'

const cardHtml = `
<ul>
  <li>
    <div data-entity-urn="urn:li:jobPosting:42424242">
      <h3 class="base-search-card__title">Senior Frontend Developer</h3>
      <h4 class="base-search-card__subtitle">Example Inc</h4>
      <span class="job-search-card__location">Remote - Europe</span>
      <span class="job-search-card__salary-info">$90,000 - $120,000</span>
      <time datetime="2026-08-30"></time>
      <a href="https://www.linkedin.com/jobs/view/senior-frontend-developer-42424242"></a>
    </div>
  </li>
</ul>`

const detailHtml = `
<section>
  <div class="show-more-less-html__markup">
    <p>Build Vue and TypeScript product surfaces.</p>
    <p>Remote work is available.</p>
  </div>
  <div class="compensation__salary">$95,000 - $125,000</div>
  <ul>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Seniority level</h3>
      <span class="description__job-criteria-text">Senior level</span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Employment type</h3>
      <span class="description__job-criteria-text">Full-time</span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Job function</h3>
      <span class="description__job-criteria-text">Engineering</span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">Industries</h3>
      <span class="description__job-criteria-text">Software Development</span>
    </li>
  </ul>
  <code id="applyUrl">https://www.linkedin.com/jobs/view/42424242?url=https%3A%2F%2Fjobs.example.com%2Fapply%2F42424242</code>
</section>`

test('LinkedIn guest cards normalize stable id, salary and freshness date', () => {
  const jobs = parseLinkedInJobCards(cardHtml)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].id, 'linkedin-42424242')
  assert.equal(jobs[0].title, 'Senior Frontend Developer')
  assert.equal(jobs[0].company, 'Example Inc')
  assert.equal(jobs[0].location, 'Remote - Europe')
  assert.equal(jobs[0].url, 'https://www.linkedin.com/jobs/view/42424242')
  assert.equal(jobs[0].salaryCurrency, 'USD')
  assert.equal(jobs[0].salaryMin, 90000)
  assert.equal(jobs[0].salaryMax, 120000)
  assert.equal(jobs[0].postedAt, '2026-08-30T00:00:00.000Z')
  assert.equal(jobs[0].remote, true)
})

test('LinkedIn guest query maps read-only filters to LinkedIn search parameters', () => {
  const params = buildLinkedInSearchParams('Kazakhstan', 'frontend developer', 50, {
    remoteOnly: true,
    easyApply: true,
    jobTypes: ['F', 'C'],
    companyIds: ['123', '456'],
    distance: 25,
  })

  assert.equal(params.get('location'), 'Kazakhstan')
  assert.equal(params.get('keywords'), 'frontend developer')
  assert.equal(params.get('start'), '50')
  assert.equal(params.get('sortBy'), 'DD')
  assert.match(params.get('f_TPR') || '', /^r\d+$/)
  assert.equal(params.get('f_WT'), '2')
  assert.equal(params.get('f_AL'), 'true')
  assert.equal(params.get('f_JT'), 'F,C')
  assert.equal(params.get('f_C'), '123,456')
  assert.equal(params.get('distance'), '25')
})

test('LinkedIn detail parser enriches description, criteria, apply URL and salary', () => {
  const detail = parseLinkedInJobDetail(detailHtml)
  assert.match(detail.description || '', /Vue and TypeScript/)
  assert.match(detail.description || '', /Remote work is available/)
  assert.equal(detail.employmentType, 'Full-time')
  assert.deepEqual(detail.tags, ['Senior level', 'Engineering', 'Software Development'])
  assert.equal(detail.applyUrl, 'https://jobs.example.com/apply/42424242')
  assert.equal(detail.salaryCurrency, 'USD')
  assert.equal(detail.salaryMin, 95000)
  assert.equal(detail.salaryMax, 125000)
})

test('LinkedIn authenticated detail uses semantic markup instead of rotating CSS classes', () => {
  const html = `
    <main aria-label="Основной контент">
      <div id="JobDetails_ManageJobBanner_4459449783"></div>
      <h2 class="rotating-a1b2">Об этой вакансии</h2>
      <p class="rotating-c3d4">
        <span data-testid="expandable-text-box">Why Join Exadel<br><br>Build Azure and .NET services.</span>
      </p>
      <button class="rotating-e5f6">Подать заявку</button>
    </main>`

  const detail = parseLinkedInJobDetail(html)
  assert.equal(detail.description, 'Why Join Exadel\nBuild Azure and .NET services.')
  assert.equal(detail.vacancyStatus, undefined)
  assert.equal(parseLinkedInJobAvailability(html), 'active')
})

test('LinkedIn explicit closed notices produce a background-removal tombstone', () => {
  for (const notice of [
    'Заявки на эту вакансию больше не принимаются',
    'No longer accepting applications',
  ]) {
    const html = `<main><div>${notice}</div></main>`
    assert.equal(parseLinkedInJobAvailability(html), 'closed')
    assert.equal(parseLinkedInJobDetail(html).vacancyStatus, 'closed')
  }

  assert.equal(parseLinkedInJobAvailability('<main>Страница временно недоступна</main>'), 'unknown')
  assert.equal(parseLinkedInJobDetail('<main>Страница временно недоступна</main>').vacancyStatus, undefined)
})

test('job refresh removes explicit closed-vacancy tombstones immediately', async () => {
  const source = await readFile(new URL('../server/vacancies/application/jobsSourceRefresh.ts', import.meta.url), 'utf8')
  assert.match(source, /job\.vacancyStatus === 'closed'/)
  assert.match(source, /byKey\.delete\(dedupKey\(job\)\)/)
})

test('Voyager people transport is opt-in and requires user-provided session material', () => {
  const previous = {
    enabled: process.env.HIRING_LINKEDIN_VOYAGER,
    cookie: process.env.HIRING_LINKEDIN_COOKIE,
    csrf: process.env.HIRING_LINKEDIN_CSRF_TOKEN,
    liAt: process.env.HIRING_LINKEDIN_LI_AT,
    jsession: process.env.HIRING_LINKEDIN_JSESSIONID,
  }
  try {
    delete process.env.HIRING_LINKEDIN_COOKIE
    delete process.env.HIRING_LINKEDIN_CSRF_TOKEN
    delete process.env.HIRING_LINKEDIN_LI_AT
    delete process.env.HIRING_LINKEDIN_JSESSIONID
    process.env.HIRING_LINKEDIN_VOYAGER = 'on'
    assert.equal(linkedinVoyagerConfigured(), false)

    process.env.HIRING_LINKEDIN_LI_AT = 'test-li-at'
    process.env.HIRING_LINKEDIN_JSESSIONID = 'ajax:test-csrf'
    assert.equal(linkedinVoyagerConfigured(), true)

    process.env.HIRING_LINKEDIN_VOYAGER = 'off'
    assert.equal(linkedinVoyagerConfigured(), false)
  } finally {
    for (const [key, value] of Object.entries({
      HIRING_LINKEDIN_VOYAGER: previous.enabled,
      HIRING_LINKEDIN_COOKIE: previous.cookie,
      HIRING_LINKEDIN_CSRF_TOKEN: previous.csrf,
      HIRING_LINKEDIN_LI_AT: previous.liAt,
      HIRING_LINKEDIN_JSESSIONID: previous.jsession,
    })) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Voyager source contains no account mutation endpoint', async () => {
  const source = await readFile(new URL('../server/hiring/sources/linkedinVoyager.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\/voyager\/api\/(?:.*\/)?(?:connect|block|unblock|invite|message|contactInfo)\b/i)
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i)
})
