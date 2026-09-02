import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REGIONAL_SERVICE_JOB_FEEDS,
  parseJobKoreaServicePage,
  parseOlxUzServicePage,
} from '../server/utils/sources/regionalServiceJobSources.ts'

test('service feed catalog covers Korea and Uzbekistan service categories', () => {
  const markets = new Set(REGIONAL_SERVICE_JOB_FEEDS.map((feed) => feed.market))
  assert.deepEqual([...markets].sort(), ['KR', 'UZ'])
  assert.ok(REGIONAL_SERVICE_JOB_FEEDS.length >= 18)

  const koreaCategories = REGIONAL_SERVICE_JOB_FEEDS
    .filter((feed) => feed.market === 'KR')
    .map((feed) => feed.category)
    .join(' ')
  for (const category of ['Waitstaff', 'Barista', 'Kitchen', 'Security', 'Cashier', 'Cleaning', 'Hotel', 'Retail', 'Warehouse', 'Delivery', 'Care']) {
    assert.match(koreaCategories, new RegExp(category))
  }

  const uzCategories = REGIONAL_SERVICE_JOB_FEEDS
    .filter((feed) => feed.market === 'UZ')
    .map((feed) => feed.category)
    .join(' ')
  for (const category of ['Restaurant', 'Security', 'Retail', 'Transport', 'Hotel', 'Housekeeping', 'Cashier']) {
    assert.match(uzCategories, new RegExp(category))
  }
})

test('JobKorea service parser maps waiter-style detail links as board vacancies', () => {
  const feed = REGIONAL_SERVICE_JOB_FEEDS.find((item) => item.label.includes('Waitstaff'))
  assert.ok(feed)

  const html = `
    <a href="/Recruit/GI_Read/49560422?Oem_Code=C1">홀써빙 파트타임 직원 구합니다</a>
    <a href="/Recruit/GI_Read/49560422?Oem_Code=C1">즉시지원</a>
  `
  const jobs = parseJobKoreaServicePage(html, feed)

  assert.equal(jobs.length, 1)
  assert.match(jobs[0].title, /홀써빙/)
  assert.equal(jobs[0].location, 'South Korea')
  assert.equal(jobs[0].source, 'companies')
  assert.equal(jobs[0].employerType, 'board')
  assert.ok(jobs[0].tags.includes('Service jobs'))
})

test('OLX Uzbekistan service parser maps restaurant vacancy detail links', () => {
  const feed = REGIONAL_SERVICE_JOB_FEEDS.find((item) => item.label.includes('Restaurants'))
  assert.ok(feed)

  const html = `
    <a href="/d/obyavlenie/trebuetsya-ofitsiant-IDabc123.html">
      Требуется официант в ресторан
    </a>
  `
  const jobs = parseOlxUzServicePage(html, feed)

  assert.equal(jobs.length, 1)
  assert.match(jobs[0].title, /официант/i)
  assert.equal(jobs[0].location, 'Tashkent, Uzbekistan')
  assert.equal(jobs[0].source, 'companies')
  assert.equal(jobs[0].employerType, 'board')
})
