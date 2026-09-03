import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseFlagmaVacancies,
  parseFlagmaVacancyDetail,
} from '../server/utils/sources/extraPublicJobSources.ts'
import {
  COMMUNITY_JOB_BOARDS,
  COMMUNITY_JOB_BOARD_TARGET_PREFIX,
  configuredCommunityJobBoardTargets,
} from '../server/utils/sources/communityJobBoardSources.ts'

const summary = {
  id: 'flagma-22245',
  title: 'Оператор чата (удалённо)',
  company: 'Flagma UZ',
  location: 'Ташкент',
  url: 'https://flagma.uz/ru/vakansiya-operator-chata-udalyonno-rv22245.html',
  source: 'companies',
  remote: true,
  tags: ['Flagma UZ', 'UZ'],
  postedAt: '2026-08-19T00:00:00.000Z',
}

const detailHtml = `
<html><head>
  <link rel="canonical" href="https://flagma.uz/ru/vakansiya-operator-chata-udalyonno-rv22245.html">
</head><body>
  <script type="application/ld+json">{
    "@type": "JobPosting",
    "title": "Оператор чата (удалённо)",
    "datePosted": "2026-08-19",
    "employmentType": "REMOTE"
  }</script>
  <h1>Оператор чата (удалённо) в Ташкенте</h1>
  <span itemprop="value" content="7500000">7 500 000</span>
  <span itemprop="currency" content="UZS">сум</span>
  <div id="company-title"><a href="/ru/3087633/"><span>OydinYo‘l, ООО</span></a><span class="terr">Ташкент, UZ</span></div>
  <div id="description-box"><div id="description"><h2>Описание вакансии</h2><div id="description-text">
    <h3>Мы предлагаем:</h3><ul><li>График на выбор 3/2, 4/2, 5/2</li></ul>
    <h3>Чем предстоит заниматься:</h3><ul><li>Вести переписку с клиентами в чатах</li><li>Отвечать по готовым скриптам</li></ul>
  </div></div></div>
  <div class="desc-bottom">Номер вакансии: 22245</div>
  <script>adsbygoogle.push({ navigation: true })</script>
</body></html>`

test('Flagma is registered as normal durable community-board targets', () => {
  const targets = configuredCommunityJobBoardTargets()
  assert.ok(targets.includes(`${COMMUNITY_JOB_BOARD_TARGET_PREFIX}flagma-ro`))
  assert.ok(targets.includes(`${COMMUNITY_JOB_BOARD_TARGET_PREFIX}flagma-uz`))
  assert.equal(COMMUNITY_JOB_BOARDS.filter((board) => board.key.startsWith('flagma-')).length, 2)
})

test('Flagma list parser reads vacancy cards for the shared crawler', () => {
  const html = `
  <article>
    <a href="https://flagma.uz/ru/vakansiya-operator-chata-udalyonno-rv22245.html">Оператор чата (удалённо)</a>
    <div>OydinYo‘l, ООО | Ташкент, UZ</div>
    <div>в Ташкенте, удаленно</div>
  </article>`
  const board = COMMUNITY_JOB_BOARDS.find((item) => item.key === 'flagma-uz')
  assert.ok(board)
  const jobs = parseFlagmaVacancies(html, board)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].id, 'flagma-22245')
  assert.equal(jobs[0].title, 'Оператор чата (удалённо)')
  assert.equal(jobs[0].remote, true)
  assert.match(jobs[0].url, /-rv22245\.html$/)
})

test('Flagma detail parser reads authoritative vacancy fields without related cards or ads', () => {
  const job = parseFlagmaVacancyDetail(detailHtml, summary)
  assert.ok(job)
  assert.equal(job.title, 'Оператор чата (удалённо)')
  assert.equal(job.company, 'OydinYo‘l, ООО')
  assert.equal(job.location, 'Ташкент, UZ')
  assert.equal(job.salaryMin, 7500000)
  assert.equal(job.salaryMax, 7500000)
  assert.equal(job.salaryCurrency, 'UZS')
  assert.equal(job.salaryPeriod, 'month')
  assert.equal(job.employmentType, 'REMOTE')
  assert.match(job.description || '', /Вести переписку с клиентами/)
  assert.doesNotMatch(job.description || '', /Номер вакансии|adsbygoogle/)
})

test('Flagma detail parser keeps a pay range instead of collapsing it onto the first number', () => {
  const rangeHtml = detailHtml.replace(
    '<span itemprop="value" content="7500000">7 500 000</span>',
    '<span itemprop="value" content="7500000">7 500 000 &mdash; 12 000 000</span>',
  )
  const job = parseFlagmaVacancyDetail(rangeHtml, summary)
  assert.ok(job)
  assert.equal(job.salaryMin, 7500000)
  assert.equal(job.salaryMax, 12000000)
  assert.equal(job.salaryCurrency, 'UZS')
  // UZ boards quote monthly pay; the shared parser's country fallback says so.
  assert.equal(job.salaryPeriod, 'month')
})

test('Flagma detail parser leaves the summary salary alone when the page prints none', () => {
  const job = parseFlagmaVacancyDetail(
    detailHtml
      .replace(/<span itemprop="value"[^]*?<\/span>/, '')
      .replace(/<span itemprop="currency"[^]*?<\/span>/, ''),
    { ...summary, salaryMin: 1, salaryMax: 2, salaryCurrency: 'USD' },
  )
  assert.ok(job)
  assert.equal(job.salaryMin, 1)
  assert.equal(job.salaryMax, 2)
  assert.equal(job.salaryCurrency, 'USD')
})

test('Flagma detail parser ignores an unrelated itemprop=value row with no explicit currency', () => {
  // No baseSalary microdata on this page (negotiable pay) — the first
  // itemprop=value node belongs to an unrelated PropertyValue (work hours),
  // and "Оплата труда" wording elsewhere in the same block must not turn
  // "9:00" into a fabricated salary via the country currency fallback.
  const noisyHtml = detailHtml
    .replace(
      '<span itemprop="value" content="7500000">7 500 000</span>',
      '<span>Оплата труда: сдельная. График: <span itemprop="value" content="9">9:00</span> до 18:00.</span>',
    )
    .replace('<span itemprop="currency" content="UZS">сум</span>', '')
  const job = parseFlagmaVacancyDetail(noisyHtml, { ...summary, salaryMin: undefined, salaryMax: undefined })
  assert.ok(job)
  assert.equal(job.salaryMin, undefined)
  assert.equal(job.salaryMax, undefined)
})

test('Flagma detail parser rejects a captcha or generic shell', () => {
  assert.equal(parseFlagmaVacancyDetail('<html><title>Flagma</title><div>reCAPTCHA</div></html>', summary), null)
})
