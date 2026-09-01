import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJobsUaVacancies } from '../server/utils/jobsUaSource.ts'

const NOW = new Date('2026-08-27T12:00:00.000Z')

test('Jobs.ua list cards become normalized jobs without detail-page crawling', () => {
  const html = `
    <ul class="b-vacancy__list js-items_block">
      <li class="b-vacancy__item js-item_list" id="3824992">
        <div class="b-vacancy__top">
          <a class="b-vacancy__top__title js-item_title"
             href="https://jobs.ua/job-zvaryuvalnik-3824992">Зварювальник</a>
          <span class="b-vacancy__top__pay">50 000&nbsp;<i>грн.</i></span>
        </div>
        <div class="b-vacancy__tech">
          <span class="b-vacancy__tech__item"><span class="link__hidden" title="Індор-Плюс">Індор-Плюс</span></span>
          <span class="b-vacancy__tech__item"><a class="link__hidden" href="https://jobs.ua/city/kiev_jobs">Київ</a></span>
        </div>
        <span class="b-vacancy__tech__item">
          <span class="caption">Графік роботи:</span><span class="black-text">повний робочий день</span>
        </span>
        <div class="grey-light b-text">Зварювання металевих конструкцій &amp; контроль якості.</div>
      </li>
    </ul>
  `

  const [job] = parseJobsUaVacancies(html, NOW)
  assert.ok(job)
  assert.equal(job.id, 'companies-jobs-ua-3824992')
  assert.equal(job.title, 'Зварювальник')
  assert.equal(job.company, 'Індор-Плюс')
  assert.equal(job.location, 'Київ, Ukraine')
  assert.equal(job.country, 'UA')
  assert.equal(job.salaryMin, 50_000)
  assert.equal(job.salaryMax, 50_000)
  assert.equal(job.salaryCurrency, 'UAH')
  assert.equal(job.salaryPeriod, 'month')
  assert.equal(job.employmentKind, 'fulltime')
  assert.equal(job.workMode, 'office')
  assert.equal(job.employerType, 'board')
  assert.equal(job.description, 'Зварювання металевих конструкцій & контроль якості.')
  assert.equal(job.postedAt, NOW.toISOString())
})

test('Jobs.ua parser recognizes remote, part-time, salary ranges, and duplicate cards', () => {
  const card = `
    <li id="999" class="featured b-vacancy__item js-item_list">
      <a href="/job-support-specialist-999" class="js-item_title b-vacancy__top__title">Support Specialist</a>
      <span class="b-vacancy__top__pay">1 200–1 800 USD</span>
      <div class="b-vacancy__tech">
        <span><span title="Acme &amp; Co" class="link__hidden">Acme</span></span>
        <a href="/city/lviv_jobs">Львів</a>
      </div>
      <span class="caption">Графік роботи:</span><span class="black-text">віддалена робота, неповний день</span>
      <div class="b-text grey-light">Customer support</div>
    </li>`
  const jobs = parseJobsUaVacancies(`<ul>${card}${card}</ul>`, NOW)

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].salaryMin, 1_200)
  assert.equal(jobs[0].salaryMax, 1_800)
  assert.equal(jobs[0].salaryCurrency, 'USD')
  assert.equal(jobs[0].remote, true)
  assert.equal(jobs[0].workMode, 'remote')
  assert.equal(jobs[0].employmentKind, 'parttime')
})

test('Jobs.ua parser rejects links outside Jobs.ua', () => {
  const html = `
    <li class="b-vacancy__item" id="123">
      <a class="b-vacancy__top__title" href="https://example.com/job-fake-123">Fake job</a>
    </li>`
  assert.deepEqual(parseJobsUaVacancies(html, NOW), [])
})
