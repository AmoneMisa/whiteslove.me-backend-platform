import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOU_CATEGORIES,
  parseDjinniPage,
  parseRobotaUaPage,
  parseRobotaUaProfessionalStreams,
  parseWorkUaCategoryIndex,
  parseWorkUaPage,
} from '../server/utils/ukraineJobSources.ts'

const NOW = new Date('2026-08-28T12:00:00.000Z')

test('DOU ingestion uses the complete source category surface instead of an IT-only subset', () => {
  assert.ok(DOU_CATEGORIES.length >= 55)
  for (const category of [
    'Front End',
    'Account Manager',
    'AI/ML',
    'Finance',
    'Legal',
    'Procurement',
    'Salesforce',
    'Technical Writer',
    'Військова справа',
  ]) {
    assert.ok(DOU_CATEGORIES.includes(category), `missing DOU category: ${category}`)
  }
})

test('Work.ua category discovery follows the board taxonomy and does not depend on frontend keywords', () => {
  const html = `
    <main>
      <h1>Вакансії за категоріями</h1>
      <a href="/jobs-it/">IT, комп'ютери, інтернет 5 527</a>
      <a href="/jobs-logistic-supply-chain/">Логістика, склад, ЗЕД 10 781</a>
      <a href="/jobs-medicine-pharmaceuticals/">Медицина, фармацевтика 7 700</a>
      <h2>Вакансії за містами</h2>
      <a href="/jobs-kyiv/">Київ 31 000</a>
    </main>
  `

  const streams = parseWorkUaCategoryIndex(html)
  assert.deepEqual(streams.map((stream) => stream.key), ['it', 'logistic-supply-chain', 'medicine-pharmaceuticals'])
  assert.equal(streams[0].baseUrl, 'https://www.work.ua/jobs-it/')
  assert.ok(!streams.some((stream) => stream.key === 'kyiv'))
})

test('robota.ua discovery is scoped to professional spheres, not only popular professions', () => {
  const html = `
    <main>
      <h2>Професійні сфери</h2>
      <a href="/zapros/vyrobnytstvo/ukraine">Виробництво</a>
      <a href="/zapros/it/ukraine">IT</a>
      <a href="/zapros/banky/ukraine">Банки</a>
      <h3>Популярні професії</h3>
      <a href="/zapros/vodiy/ukraine">Водій</a>
    </main>
  `

  const streams = parseRobotaUaProfessionalStreams(html)
  assert.deepEqual(streams.map((stream) => stream.key), ['vyrobnytstvo', 'it', 'banky'])
  assert.ok(!streams.some((stream) => stream.key === 'vodiy'))
})

test('Work.ua public search cards become Ukraine board jobs', () => {
  const html = `
    <section>
      <a href="/jobs/1234567/">
        <h2>Frontend Developer</h2>
      </a>
      <div>Acme · Київ · віддалена робота · 60 000 грн</div>
      <p>Vue, TypeScript, REST API</p>
    </section>
  `

  const [job] = parseWorkUaPage(html, 'IT, комп\'ютери, інтернет', NOW)
  assert.ok(job)
  assert.equal(job.id, 'companies-workua-1234567')
  assert.equal(job.title, 'Frontend Developer')
  assert.equal(job.country, 'UA')
  assert.equal(job.source, 'companies')
  assert.equal(job.remote, true)
  assert.equal(job.url, 'https://www.work.ua/jobs/1234567/')
  assert.ok(job.tags.includes('Work.ua'))
  assert.equal(job.postedAt, NOW.toISOString())
})

test('robota.ua public search cards become Ukraine board jobs', () => {
  const html = `
    <article>
      <a href="/company123/vacancy9876543">
        <h2>React Developer</h2>
      </a>
      <div>Example · Львів · remote · 2 000 USD</div>
      <p>React, JavaScript, GraphQL</p>
    </article>
  `

  const [job] = parseRobotaUaPage(html, 'IT', NOW)
  assert.ok(job)
  assert.equal(job.id, 'companies-robotaua-9876543')
  assert.equal(job.title, 'React Developer')
  assert.equal(job.country, 'UA')
  assert.equal(job.source, 'companies')
  assert.equal(job.remote, true)
  assert.equal(job.url, 'https://robota.ua/company123/vacancy9876543')
  assert.ok(job.tags.includes('Robota.ua'))
  assert.equal(job.postedAt, NOW.toISOString())
})

test('Djinni public jobs page participates in cyclic coverage, not RSS only', () => {
  const html = `
    <article>
      <a href="/jobs/842134-executive-recruiter/"><h2>Executive Recruiter</h2></a>
      <div>Full Remote · Countries of Europe or Ukraine · 3 years of experience</div>
      <p>Talent acquisition and headhunting</p>
    </article>
  `

  const [job] = parseDjinniPage(html, NOW)
  assert.ok(job)
  assert.equal(job.id, 'companies-djinni-842134')
  assert.equal(job.source, 'companies')
  assert.equal(job.country, 'UA')
  assert.equal(job.remote, true)
  assert.equal(job.url, 'https://djinni.co/jobs/842134-executive-recruiter/')
  assert.equal(job.postedAt, NOW.toISOString())
})
