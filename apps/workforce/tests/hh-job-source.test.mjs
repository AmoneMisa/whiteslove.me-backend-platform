import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = await mkdtemp(join(tmpdir(), 'hh-job-cursor-'))
const originalStateDir = process.env.SITE_STATE_DIR
process.env.SITE_STATE_DIR = stateDir
const {
  configuredHhJobTargets,
  publicationSlices,
  fetchHhJobTarget,
  mapHhVacancy,
} = await import('../server/utils/sources/hhJobSource.ts')

test.after(async () => {
  if (originalStateDir === undefined) delete process.env.SITE_STATE_DIR
  else process.env.SITE_STATE_DIR = originalStateDir
  await rm(stateDir, { recursive: true, force: true })
})

test('HH public vacancy cards map into the shared jobs contract', () => {
  const job = mapHhVacancy({
    id: '123',
    name: 'Node.js разработчик',
    alternate_url: 'https://tashkent.hh.uz/vacancy/123',
    published_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    employer: { name: 'Example' },
    area: { name: 'Ташкент' },
    salary: { from: 12_000_000, to: 18_000_000, currency: 'UZS', gross: false },
    snippet: { requirement: '<highlighttext>Node.js</highlighttext> и PostgreSQL' },
    schedule: { id: 'remote', name: 'Удаленная работа' },
    employment: { id: 'full', name: 'Полная занятость' },
    professional_roles: [{ name: 'Программист, разработчик' }],
  })

  assert.ok(job)
  assert.equal(job.id, 'hh-123')
  assert.equal(job.source, 'hh')
  assert.equal(job.country, 'UZ')
  assert.equal(job.city, 'Ташкент')
  assert.equal(job.remote, true)
  assert.equal(job.salaryMin, 12_000_000)
  assert.equal(job.salaryCurrency, 'UZS')
  assert.equal(job.description, 'Node.js и PostgreSQL')
})

test('HH exposes each configured area as its own shared-crawler queue target', async () => {
  const originalFetch = globalThis.fetch
  const originalCountries = process.env.HH_JOB_COUNTRIES
  const originalAreas = process.env.HH_JOB_AREAS
  const originalToken = process.env.HH_APP_TOKEN
  process.env.HH_JOB_COUNTRIES = 'UZ'
  process.env.HH_JOB_AREAS = '2759'
  process.env.HH_APP_TOKEN = 'test-app-token'
  const calls = []

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, headers: new Headers(init?.headers) })
    const page = Number(url.searchParams.get('page'))
    const item = (id) => ({
      id,
      name: `Vacancy ${id}`,
      alternate_url: `https://tashkent.hh.uz/vacancy/${id}`,
      published_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      employer: { name: 'Example' },
      area: { name: 'Ташкент' },
    })
    return Response.json({ items: page === 0 ? [item('1')] : [item('1'), item('2')] })
  }

  try {
    assert.deepEqual(configuredHhJobTargets(), ['hh-job-source:uz:area-2759'])
    const jobs = await fetchHhJobTarget('hh-job-source:uz:area-2759')
    assert.deepEqual(jobs.map((job) => job.id), ['hh-1', 'hh-2'])
    // One search per publication window (hh.ru answers at most 2,000 results
    // per search), each crawled to its natural end: pages 0, 1 and the
    // repeated page 2 that ends it.
    const slices = publicationSlices()
    assert.equal(calls.length, slices.length * 3)
    assert.deepEqual(calls.slice(0, 3).map(({ url }) => url.searchParams.get('page')), ['0', '1', '2'])
    // The newest and oldest edges move with the clock; the aligned half-days
    // between them must match exactly.
    const searched = [...new Set(calls.map(({ url }) => `${url.searchParams.get('date_from')}|${url.searchParams.get('date_to')}`))]
    assert.equal(searched.length, slices.length)
    assert.deepEqual(searched.slice(1, -1), slices.slice(1, -1).map((slice) => `${slice.from}|${slice.to}`))
    assert.equal(calls[0].url.searchParams.get('host'), 'hh.uz')
    assert.equal(calls[0].url.searchParams.get('area'), '2759')
    assert.equal(calls[0].url.searchParams.get('per_page'), '100')
    assert.match(calls[0].headers.get('hh-user-agent') || '', /WhitesLove/u)
    // hh.ru closed anonymous access: every request carries the app token.
    assert.ok(calls.every(({ headers }) => headers.get('authorization') === 'Bearer test-app-token'))
  } finally {
    if (originalToken === undefined) delete process.env.HH_APP_TOKEN
    else process.env.HH_APP_TOKEN = originalToken
    globalThis.fetch = originalFetch
    if (originalCountries === undefined) delete process.env.HH_JOB_COUNTRIES
    else process.env.HH_JOB_COUNTRIES = originalCountries
    if (originalAreas === undefined) delete process.env.HH_JOB_AREAS
    else process.env.HH_JOB_AREAS = originalAreas
  }
})

test('without hh.ru credentials the source is off rather than failing every task', async () => {
  const { isJobSourceAvailable } = await import('../server/utils/sources/jobSourceConfig.ts')
  const saved = { t: process.env.HH_APP_TOKEN, i: process.env.HH_CLIENT_ID, s: process.env.HH_CLIENT_SECRET }
  try {
    delete process.env.HH_APP_TOKEN; delete process.env.HH_CLIENT_ID; delete process.env.HH_CLIENT_SECRET
    assert.equal(isJobSourceAvailable('hh', 'ingestion'), false)
    process.env.HH_CLIENT_ID = 'id'
    assert.equal(isJobSourceAvailable('hh', 'ingestion'), false)
    process.env.HH_CLIENT_SECRET = 'secret'
    assert.equal(isJobSourceAvailable('hh', 'ingestion'), true)
  } finally {
    for (const [k, v] of [['HH_APP_TOKEN', saved.t], ['HH_CLIENT_ID', saved.i], ['HH_CLIENT_SECRET', saved.s]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

test('publication windows cover the last 14 days without gaps, 12 hours at most each', () => {
  const now = Date.parse('2026-09-28T15:20:00Z')
  const slices = publicationSlices(now)
  assert.equal(slices[0].to, new Date(now).toISOString())
  assert.equal(slices[0].from, '2026-09-28T12:00:00.000Z')
  assert.equal(slices.at(-1).from, new Date(now - 14 * 86_400_000).toISOString())
  for (let i = 0; i < slices.length; i += 1) {
    const span = Date.parse(slices[i].to) - Date.parse(slices[i].from)
    assert.ok(span > 0 && span <= 12 * 3_600_000, `slice ${i}`)
    if (i > 0) assert.equal(slices[i].to, slices[i - 1].from, `gap before slice ${i}`)
  }
})
