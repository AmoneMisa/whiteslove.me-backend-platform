import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseCuratedRemoteBoardHtml,
  parseWorkingNomadsItems,
} from '../server/utils/curatedRemoteJobSources.ts'

test('Remote.co JSON-LD maps through the shared jobs contract', () => {
  const html = `
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Frontend Developer",
        "url": "https://remote.co/job-details/frontend-developer-123",
        "datePosted": "2026-08-28",
        "jobLocationType": "TELECOMMUTE",
        "hiringOrganization": { "name": "Example Labs" },
        "employmentType": "FULL_TIME",
        "description": "Vue and TypeScript. Salary $90,000-$110,000 per year."
      }
    </script>`

  const [job] = parseCuratedRemoteBoardHtml(html, 'remote-co')
  assert.ok(job)
  assert.equal(job.source, 'companies')
  assert.equal(job.company, 'Example Labs')
  assert.equal(job.location, 'Remote')
  assert.equal(job.remote, true)
  assert.equal(job.employerType, 'board')
  assert.ok(job.tags.includes('Remote.co'))
  assert.equal(job.salaryCurrency, 'USD')
})

test('FlexJobs card links are normalized without inventing an employer', () => {
  const html = `
    <article class="job-card">
      <div class="company-name">Acme</div>
      <div data-testid="job-location">Remote - Europe</div>
      <time datetime="2026-08-29T08:00:00Z">today</time>
      <a href="/publicjobs/senior-vue-developer-abc123">Senior Vue Developer</a>
      <p>Full-time remote role using Vue 3 and TypeScript.</p>
    </article>`

  const [job] = parseCuratedRemoteBoardHtml(html, 'flexjobs')
  assert.ok(job)
  assert.equal(job.title, 'Senior Vue Developer')
  assert.equal(job.company, 'Acme')
  assert.equal(job.location, 'Remote - Europe')
  assert.equal(job.remote, true)
  assert.match(job.url, /^https:\/\/www\.flexjobs\.com\/publicjobs\//)
})

test('Working Nomads public API fields map to normalized jobs', () => {
  const [job] = parseWorkingNomadsItems([{
    url: 'https://www.workingnomads.com/jobs/frontend-engineer-12345',
    title: 'Frontend Engineer',
    description: '<p>Build interfaces with Vue and TypeScript.</p>',
    company_name: 'Nomad Labs',
    category_name: 'Development',
    tags: 'JavaScript, Vue.js, TypeScript',
    location: 'Anywhere',
    pub_date: '2026-08-29T06:00:00Z',
  }])

  assert.ok(job)
  assert.equal(job.company, 'Nomad Labs')
  assert.equal(job.remote, true)
  assert.ok(job.tags.includes('Working Nomads'))
  assert.ok(job.tags.includes('Development'))
  assert.match(job.description || '', /Vue and TypeScript/)
})

test('SkipTheDrive accepts only job detail links from a category page', () => {
  const html = `
    <a href="/job-category/remote-software-development-jobs/">Software Development</a>
    <article>
      <span class="company">Example Inc</span>
      <a href="/job/senior-frontend-engineer/">Senior Frontend Engineer</a>
      <p>Remote role. Posted 2 days ago.</p>
    </article>
  `
  const jobs = parseCuratedRemoteBoardHtml(
    html,
    'skip-the-drive',
    'https://www.skipthedrive.com/job-category/remote-software-development-jobs/',
  )

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].company, 'Example Inc')
  assert.equal(jobs[0].remote, true)
  assert.equal(jobs[0].url, 'https://www.skipthedrive.com/job/senior-frontend-engineer/')
})
