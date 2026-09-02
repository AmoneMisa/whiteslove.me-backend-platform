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
    published_at: '2026-08-30T10:00:00+0500',
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
  process.env.HH_JOB_COUNTRIES = 'UZ'
  process.env.HH_JOB_AREAS = '2759'
  const calls = []

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, headers: new Headers(init?.headers) })
    const page = Number(url.searchParams.get('page'))
    const item = (id) => ({
      id,
      name: `Vacancy ${id}`,
      alternate_url: `https://tashkent.hh.uz/vacancy/${id}`,
      published_at: '2026-08-30T10:00:00+0500',
      employer: { name: 'Example' },
      area: { name: 'Ташкент' },
    })
    return Response.json({ items: page === 0 ? [item('1')] : [item('1'), item('2')] })
  }

  try {
    assert.deepEqual(configuredHhJobTargets(), ['hh-job-source:uz:area-2759'])
    const jobs = await fetchHhJobTarget('hh-job-source:uz:area-2759')
    assert.deepEqual(jobs.map((job) => job.id), ['hh-1', 'hh-2'])
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map(({ url }) => url.searchParams.get('page')), ['0', '1', '2'])
    assert.equal(calls[0].url.searchParams.get('host'), 'hh.uz')
    assert.equal(calls[0].url.searchParams.get('area'), '2759')
    assert.equal(calls[0].url.searchParams.get('per_page'), '100')
    assert.match(calls[0].headers.get('hh-user-agent') || '', /WhitesLove/u)
  } finally {
    globalThis.fetch = originalFetch
    if (originalCountries === undefined) delete process.env.HH_JOB_COUNTRIES
    else process.env.HH_JOB_COUNTRIES = originalCountries
    if (originalAreas === undefined) delete process.env.HH_JOB_AREAS
    else process.env.HH_JOB_AREAS = originalAreas
  }
})
