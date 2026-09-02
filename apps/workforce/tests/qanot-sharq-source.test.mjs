import assert from 'node:assert/strict'
import test from 'node:test'

import { parseQanotSharqHtml } from '../server/utils/sources/sourceExpansionJobs.ts'

const card = (title, body, state = '') => `
  <div data-headlessui-state="${state}" class="vacancy-card">
    <button type="button"><span class="text-semibold text-[20px]/[24px]">${title}</span></button>
    <div style="${state ? 'height:auto' : 'display:none'}">
      <div><div class="body-content font-normal text-[14px]/[17px]">${body}</div>
      <button class="submit">Submit Resume</button></div>
    </div>
  </div>`

test('Qanot Sharq parser scopes descriptions to accordion vacancy bodies', () => {
  const html = `<html><head>
    <style>:root { --color-primary-50: 244 245 246 } .carousel { position: relative }</style>
    <script>window.__NUXT__ = { dangerous: 'script payload' }</script>
  </head><body>
    ${card('Recruitment for the position of captain and co-pilot of the Airbus 320/321/330', `
      <p><strong>Candidate Requirements:</strong></p>
      <ul><li>Valid ATPL;</li><li>ICAO English level 4 or higher.</li></ul>
      <p>The selection will take place in <strong>Tashkent</strong>.</p>`, 'open')}
    ${card('Schedule Planning and International Relations Specialist', `
      <p>Company: Qanot Sharq Airlines</p><p>Location: Tashkent, Uzbekistan</p>
      <p>Preparation and coordination of flight permissions.</p>`)}
  </body></html>`

  const jobs = parseQanotSharqHtml(html)
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].title, 'Captain / First Officer — Airbus A320/A321/A330')
  assert.match(jobs[0].description, /Valid ATPL/)
  assert.doesNotMatch(jobs[0].description, /--color-primary|carousel|__NUXT__|Schedule Planning/)
  assert.equal(jobs[1].location, 'Tashkent, Uzbekistan')
  assert.match(jobs[1].description, /flight permissions/)
})

test('collapsed Qanot Sharq cards are parsed from server-rendered HTML too', () => {
  const jobs = parseQanotSharqHtml(card('Qanot Sharq AK is looking for a responsible Call Center Operator.', '<p>Handle passenger requests.</p>'))
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].title, 'Call Center Operator')
  assert.equal(jobs[0].description, 'Handle passenger requests.')
})
