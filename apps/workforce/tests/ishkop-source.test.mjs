import assert from 'node:assert/strict'
import test from 'node:test'
import { parseIshkopVacancyDetail } from '../server/utils/sources/sourceExpansionJobs.ts'

const detailHtml = `
<html lang="ru"><head>
  <meta property="og:url" content="https://ishkop.uz/jobdesc?id=4770245&amp;src=sn">
</head><body>
  <div class="title-wrap"><h1>Супервайзер</h1></div>
  <div class="company-wrap">Pos Retail</div>
  <table><tbody>
    <tr><td class="name jobtype">Занятость</td><td class="value">Полная занятость</td></tr>
    <tr><td class="name location"><span>Адрес</span></td><td class="value"><span id="spnLocation">Узбекистан, Нукус</span></td></tr>
  </tbody></table>
  <div class="section-title">Описание вакансии</div>
  <div class="text"><p>POS Retail расширяет команду!</p><p>Ищем сильного супервайзера, который организует работу команды агентов и контролирует выполнение планов продаж.</p></div>
  <div class="section-title">Требования</div>
  <div class="source">Добавлено вчера</div>
</body></html>`

test('Ishkop detail parser scopes real vacancy fields without page chrome', () => {
  const job = parseIshkopVacancyDetail(detailHtml, 'https://ishkop.uz/jobdesc?id=4770245')
  assert.ok(job)
  assert.equal(job.title, 'Супервайзер')
  assert.equal(job.company, 'Pos Retail')
  assert.equal(job.location, 'Узбекистан, Нукус')
  assert.equal(job.url, 'https://ishkop.uz/jobdesc?id=4770245&src=sn')
  assert.equal(job.employmentType, 'Полная занятость')
  assert.match(job.description || '', /организует работу команды агентов/)
  assert.doesNotMatch(job.description || '', /Пожаловаться|Отклик на HeadHunter|commonRoot/)
})

test('Ishkop detail parser rejects non-vacancy and empty shell pages', () => {
  assert.equal(parseIshkopVacancyDetail('<html><h1>Работа в Узбекистане</h1></html>', 'https://ishkop.uz/'), null)
})
