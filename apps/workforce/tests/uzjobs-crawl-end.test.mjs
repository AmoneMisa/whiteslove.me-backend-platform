import assert from 'node:assert/strict'
import test from 'node:test'

const { crawlUzJobs } = await import('../server/hiring/sources/web/uzJobs.ts')

const stamp = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:00`
}
const row = (id) => `<tr><td class="td_left_id">${id}</td><td>Banking / Cashier ${id}</td><td class="td_region">Tashkent</td><td class="td_kol_vak">${stamp()}</td></tr>`
const page = (ids) => `<table>${ids.map(row).join('')}</table>`

// The site has `real` pages of three resumes and answers every later page with the last one again.
function serve(real) {
  const requested = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const number = Number(String(url).match(/resume-2-(\d+)\.html/)?.[1])
    requested.push(number)
    if (requested.length > 50) throw new Error('the crawl did not stop')
    const shown = Math.min(number, real)
    return new Response(page([50000 + shown * 10 + 1, 50000 + shown * 10 + 2, 50000 + shown * 10 + 3]), { status: 200 })
  }
  return { requested, restore: () => { globalThis.fetch = original } }
}

test('a first crawl ends when the site starts repeating its last page', async () => {
  const site = serve(4)
  try {
    const run = await crawlUzJobs()
    assert.equal(run.cursor.bootstrapComplete, true)
    assert.equal(run.profiles.length, 12, 'every page of the real four was taken once')
    assert.deepEqual(site.requested.slice(0, 6), [1, 2, 3, 4, 5, 6].slice(0, site.requested.length))
    assert.ok(site.requested.length <= 6, `stopped after the repeat, requested ${site.requested.join(',')}`)
  } finally {
    site.restore()
  }
})

test('a crawl whose remembered profile no longer exists ends at the repeat instead of walking forever', async () => {
  const site = serve(3)
  try {
    const run = await crawlUzJobs({
      sourceKey: 'uzjobs-resumes',
      lastSeenProfileId: 'https://uzjobs.uz/resume.cgi?srid=99939',
      lastSeenUrl: 'https://uzjobs.uz/resume.cgi?srid=99939',
      lastSeenUpdatedAt: null,
      backfillPage: 1,
      bootstrapComplete: true,
      lastSuccessAt: null,
    })
    assert.equal(run.profiles.length, 9)
    assert.ok(site.requested.length <= 5, `requested ${site.requested.join(',')}`)
  } finally {
    site.restore()
  }
})
