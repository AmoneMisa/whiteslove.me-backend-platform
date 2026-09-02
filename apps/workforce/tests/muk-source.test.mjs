import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMukVacancyDetail } from '../server/utils/sources/sourceExpansionJobs.ts'

const detailHtml = `
<html lang="ru"><head>
  <meta property="og:description" content="Welcome to MUK – a reliable multi-vendor IT distributor.">
</head><body>
  <nav><a href="/ru/country/uz">Узбекистан</a></nav>
  <div class="news-detail menu-indent">
    <div class="news-title"><div class="container"><h3>Администратор</h3></div></div>
    <div class="news-info"><div class="container"><div class="news-info_left">Узбекистан</div></div></div>
    <div class="news-body"><div class="container"><p class="news-text"><div>
      <p><b>Требования:</b></p>Высшее образование; знание узбекского и русского языков.<br>
      <p><b>Обязанности:</b></p>Прием и распределение звонков; обработка документов в офисе.<br>
      <p><b>Личные качества:</b></p>Стрессоустойчивость и пунктуальность.
    </div></p></div></div>
  </div>
  <div id="footer">© MUK. Все права защищены.</div>
  <script>window.dataLayer = ['navigation garbage']</script>
</body></html>`

test('MUK detail parser reads the vacancy body instead of global company metadata', () => {
  const job = parseMukVacancyDetail(detailHtml, 'https://muk.group/ru/vacancies/923')
  assert.ok(job)
  assert.equal(job.title, 'Администратор')
  assert.equal(job.company, 'MUK')
  assert.equal(job.location, 'Uzbekistan')
  assert.match(job.description || '', /Прием и распределение звонков/)
  assert.doesNotMatch(job.description || '', /Welcome to MUK|Все права защищены|dataLayer/)
})

test('MUK detail parser rejects generic company pages without a vacancy body', () => {
  assert.equal(parseMukVacancyDetail('<html><title>MUK</title><div>Узбекистан</div></html>', 'https://muk.group/ru/'), null)
})
