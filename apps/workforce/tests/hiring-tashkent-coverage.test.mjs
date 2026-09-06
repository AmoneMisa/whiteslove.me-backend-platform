import assert from 'node:assert/strict'
import test from 'node:test'

import { emptyWebCursor } from '../shared/hiring/hiringCursors.ts'
import { crawlIshBorPages } from '../shared/hiring/sources/ishBorCrawler.ts'
import { listHiringLinkedInSourceKeys } from '../shared/hiring/sources/linkedInSources.ts'
import { listHiringSocialSourceKeys } from '../shared/hiring/sources/socialSources.ts'
import { HIRING_TELEGRAM_CHANNELS } from '../shared/hiring/sources/telegramChannels.ts'
import { WEB_CV_SOURCES } from '../shared/hiring/sources/webCvSources.ts'
import { HH_UZ_SOURCE } from '../server/hiring/sources/web/hhUz.ts'
import { parseUzJobsResumeRows } from '../server/hiring/sources/web/uzJobs.ts'
import { webProfileId } from '../server/hiring/sources/web/crawler.ts'
import { hiringLinkedInSourceHandles, listHiringLinkedInSources } from '../server/hiring/sources/linkedInRefresh.ts'
import { hiringSocialSourceHandles, listSocialSources } from '../server/hiring/sources/socialRefresh.ts'

test('Tashkent hiring discovery uses broad RU, UZ and EN social search coverage', () => {
  const social = listHiringSocialSourceKeys().filter((key) => key.startsWith('threads-uz-'))
  const linkedin = listHiringLinkedInSourceKeys().filter((key) => key.startsWith('linkedin-uz-'))

  assert.ok(social.length >= 9)
  assert.ok(linkedin.length >= 8)
  assert.ok(social.includes('threads-uz-ru-parttime'))
  assert.ok(social.includes('threads-uz-uz-izlayapman'))
  assert.ok(social.includes('threads-uz-en-looking'))
  assert.ok(linkedin.includes('linkedin-uz-tashkent-open-to-work'))
  assert.ok(linkedin.includes('linkedin-uz-tashkent-ish-qidiryapman'))
})

test('shared social/LinkedIn discovery catalogs stay aligned with executable targets', () => {
  const socialRuntime = new Set(hiringSocialSourceHandles().map((value) => value.replace(/^social:/, '')))
  const linkedInRuntime = new Set(hiringLinkedInSourceHandles().map((value) => value.replace(/^linkedin:/, '')))

  assert.deepEqual(new Set(listHiringSocialSourceKeys()), socialRuntime)
  assert.deepEqual(new Set(listSocialSources().map((source) => source.key)), socialRuntime)
  assert.deepEqual(new Set(listHiringLinkedInSourceKeys()), linkedInRuntime)
  assert.deepEqual(new Set(listHiringLinkedInSources().map((source) => source.key)), linkedInRuntime)
})

test('Tashkent-heavy public resume Telegram feeds are part of the canonical hiring catalog', () => {
  const byHandle = new Map(HIRING_TELEGRAM_CHANNELS.map((channel) => [channel.handle.toLowerCase(), channel]))

  for (const handle of ['ish_uz', 'freelancer_uzbek', 'jobs_uz_vacancy', 'hrangels']) {
    const source = byHandle.get(handle)
    assert.ok(source, handle)
    assert.equal(source.country, 'UZ')
    assert.equal(source.requireCandidateMarker, true)
    assert.equal(source.priority, 'high')
  }
})

test('Uzbekistan web-CV catalog includes hh.uz Tashkent and UzJobs resumes', () => {
  const uz = new Map(WEB_CV_SOURCES.filter((source) => source.country === 'UZ').map((source) => [source.key, source]))
  assert.ok(uz.has('flagma-uz'))
  assert.ok(uz.has('careerist-uz'))
  assert.ok(uz.has('hh-uz-tashkent'))
  assert.ok(uz.has('uzjobs-resumes'))
  assert.ok(uz.size >= 4)
})

test('hh.uz Tashkent resume cards map recent active candidates and reject not-looking profiles', () => {
  const active = HH_UZ_SOURCE.parse({
    href: 'https://tashkent.hh.uz/resume/9c9b48fe00045b3f780039ed1f74585a457863',
    title: 'Менеджер по продажам',
    html: '',
    text: '30 лет · Обновлено сегодня · Активно ищет работу · Общий опыт 7 лет 1 месяц · 10 000 000 сум',
  }, HH_UZ_SOURCE)
  assert.ok(active)
  assert.equal(active.country, 'UZ')
  assert.equal(active.city, 'Tashkent')
  assert.equal(active.role, 'Менеджер по продажам')
  assert.deepEqual(active.professions, ['Sales Manager'])

  const inactive = HH_UZ_SOURCE.parse({
    href: 'https://tashkent.hh.uz/resume/5b5837ce00018fd7290039ed1f57486e41646e',
    title: 'Повар',
    html: '',
    text: '40 лет · Обновлено сегодня · Не ищет работу · Общий опыт 3 года',
  }, HH_UZ_SOURCE)
  assert.equal(inactive, null)
})

test('UzJobs locked resume table rows still become anonymized hiring candidates', () => {
  const html = `
    <table>
      <tr>
        <td>100046</td>
        <td>Services / Administrator<br>Trade and sales / Sales manager</td>
        <td>Tashkent</td>
        <td>29.08.2026 10:15:00</td>
      </tr>
    </table>
  `
  const profiles = parseUzJobsResumeRows(html)
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].country, 'UZ')
  assert.equal(profiles[0].city, 'Tashkent')
  assert.equal(profiles[0].role, 'Administrator')
  assert.match(profiles[0].url, /resume_view-100046-/)
  assert.equal(profiles[0].contactType, 'platform')
  assert.equal(profiles[0].contact, profiles[0].url)
})

test('web candidate cursor identities support hh hashes and UzJobs ids', () => {
  assert.equal(
    webProfileId('https://tashkent.hh.uz/resume/9c9b48fe00045b3f780039ed1f74585a457863?x=1'),
    '9c9b48fe00045b3f780039ed1f74585a457863',
  )
  assert.equal(webProfileId('https://uzjobs.uz/e/resume_view-100046-1-1.html'), '100046')
})

test('IshBor historical crawl continues past an old sparse page', async () => {
  const originalFetch = globalThis.fetch
  const listing = (id) => `<article><a href="/ru/ishchilar/id/${id}">Candidate ${id}</a></article>`
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === 'https://ish-bor.uz/ru/ishchilar') return new Response(listing(101))
    if (url === 'https://ish-bor.uz/ru/ishchilar?page=2') return new Response(listing(201))
    if (url === 'https://ish-bor.uz/ru/ishchilar?page=3') return new Response(listing(301))
    if (url === 'https://ish-bor.uz/ru/ishchilar?page=4') return new Response('')
    if (url.endsWith('/id/201')) return new Response('old profile')
    if (url.endsWith('/id/101') || url.endsWith('/id/301')) return new Response('recent profile')
    throw new Error(`unexpected fetch ${url}`)
  }

  try {
    const run = await crawlIshBorPages(
      emptyWebCursor('ishbor-uz'),
      (summary, detailHtml) => detailHtml.includes('recent') ? { id: summary.url } : null,
    )

    assert.equal(run.profiles.length, 2)
    assert.equal(run.cursor.bootstrapComplete, true)
    assert.equal(run.cursor.backfillPage, 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('IshBor retries a historical page when one of its detail requests fails', async () => {
  const originalFetch = globalThis.fetch
  const listing = (id) => `<article><a href="/ru/ishchilar/id/${id}">Candidate ${id}</a></article>`
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === 'https://ish-bor.uz/ru/ishchilar') return new Response(listing(101))
    if (url === 'https://ish-bor.uz/ru/ishchilar?page=2') return new Response(listing(201))
    if (url === 'https://ish-bor.uz/ru/ishchilar?page=3') return new Response('')
    if (url.endsWith('/id/101')) return new Response('recent profile')
    if (url.endsWith('/id/201')) throw new Error('temporary detail failure')
    throw new Error(`unexpected fetch ${url}`)
  }

  try {
    const run = await crawlIshBorPages(
      emptyWebCursor('ishbor-uz'),
      (summary, detailHtml) => detailHtml.includes('recent') ? { id: summary.url } : null,
    )

    assert.equal(run.cursor.bootstrapComplete, false)
    assert.equal(run.cursor.backfillPage, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})
