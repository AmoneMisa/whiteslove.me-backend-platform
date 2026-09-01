import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseUzbekistanAirwaysVacancyDetail,
  parseUzbekistanAirwaysVacancyPage,
} from '../server/utils/sourceExpansionJobs.ts'

test('Uzbekistan Airways parser ignores global node links and service pages', () => {
  const html = `<html><body>
    <nav>
      <a href="/ru/node/1676">ESG – Uzbekistan Airways</a>
      <a href="/ru/node/101">Путешествие по Узбекистану</a>
    </nav>
    <main><h1>Вакансии</h1><h2>Текущие вакансии</h2>
      <div class="view-content">
        <a href="/ru/node/1891">Инженер-инспектор по техническому обслуживанию группы «SAFA»</a>
        <a href="/ru/node/1882">Специалист отдела DCS</a>
        <a href="/ru/node/1622">Рекомендации по заполнению резюме</a>
        <a href="/ru/node/1391">Резюме</a>
        <a href="/ru/node/1889">Оказание услуг по перевозке топлива для реактивных двигателей</a>
      </div>
      <nav class="pager"><a href="?page=1">2</a></nav>
    </main>
    <footer><a href="/ru/node/1676">ESG – Uzbekistan Airways</a></footer>
  </body></html>`

  const jobs = parseUzbekistanAirwaysVacancyPage(html)
  assert.deepEqual(jobs.map((job) => job.title), [
    'Инженер-инспектор по техническому обслуживанию группы «SAFA»',
    'Специалист отдела DCS',
  ])
  assert.ok(jobs.every((job) => job.url.includes('/ru/node/')))
})

test('Uzbekistan Airways parser fails closed when the vacancy section is absent', () => {
  const html = '<nav><a href="/ru/node/1676">ESG – Uzbekistan Airways</a></nav>'
  assert.deepEqual(parseUzbekistanAirwaysVacancyPage(html), [])
})

test('Uzbekistan Airways detail parser extracts the job body without shared page chrome', () => {
  const html = `<html><head><title>Бортпроводник | Uzbekistan Airways</title></head><body>
    <nav><a href="/ru/node/1676">ESG – Uzbekistan Airways</a></nav>
    <h1 class="page-heading">Бортпроводник воздушного судна</h1>
    <aside>Путешествие по Узбекистану</aside>
    <div class="row page__row">
      <div class="col-sm-12 col-md-4 col-xl-12">
        <div><p><strong>Обязанности:</strong></p><ul><li>Обеспечение безопасности пассажиров.</li></ul>
        <p><strong>Требования:</strong></p><ul><li>Действующее свидетельство бортпроводника.</li></ul>
        <p><strong>Резюме отправлять:</strong> ca.school@uzairways.com</p></div>
      </div>
    </div>
    <footer>Единый контакт-центр</footer>
  </body></html>`

  const job = parseUzbekistanAirwaysVacancyDetail(html, 'https://corp.uzairways.com/ru/node/1407')
  assert.ok(job)
  assert.equal(job.title, 'Бортпроводник воздушного судна')
  assert.match(job.description, /Обеспечение безопасности пассажиров/)
  assert.match(job.description, /ca\.school@uzairways\.com/)
  assert.doesNotMatch(job.description, /ESG|Путешествие|контакт-центр/)
})

test('Uzbekistan Airways detail parser rejects non-vacancy Drupal nodes', () => {
  const html = `<h1 class="page-heading">ESG – Uzbekistan Airways</h1>
    <div class="col-sm-12 col-md-4 col-xl-12"><p>Устойчивое развитие компании</p></div></div>`
  assert.equal(parseUzbekistanAirwaysVacancyDetail(html, 'https://corp.uzairways.com/ru/node/1676'), null)
})
