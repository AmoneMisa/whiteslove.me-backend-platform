import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ELASTICSEARCH_URL = 'http://es.test:9200'
const calls = []
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname
  calls.push({ path, method: init.method || 'GET', body: typeof init.body === 'string' ? init.body : '' })
  if (init.method === 'HEAD') return new Response(null, { status: 200 })
  if (path.endsWith('/_bulk')) return Response.json({ errors: false, items: [] })
  return Response.json({ acknowledged: true })
}
const { syncJobsSearchIndex, jobSearchKey } = await import('../server/vacancies/infrastructure/jobsElastic.ts')

const job = (id, title) => ({ id, source: 'test', title, company: 'Acme', location: 'Tashkent', url: `https://x/${id}`, postedAt: '2026-09-28T10:00:00Z', tags: [] })
const bulkLines = () => calls.filter((c) => c.path.endsWith('/_bulk')).flatMap((c) => c.body.trim().split('\n').filter((l, i) => i % 2 === 0 || l.includes('"delete"')))
const actions = () => bulkLines().map((line) => Object.keys(JSON.parse(line))[0])
const sweeps = () => calls.filter((c) => c.path.endsWith('/_delete_by_query')).length

test('only new, changed or vanished vacancies reach Elasticsearch after the first sync', async () => {
  await syncJobsSearchIndex([job('a', 'Backend'), job('b', 'Designer'), job('c', 'Tester')])
  assert.deepEqual(actions(), ['index', 'index', 'index'])
  assert.equal(sweeps(), 1) // the first sync is a full one, with the sweep

  calls.length = 0
  await syncJobsSearchIndex([job('a', 'Backend'), job('b', 'Designer'), job('c', 'Tester')])
  assert.deepEqual(actions(), [])
  assert.equal(sweeps(), 0)

  calls.length = 0
  await syncJobsSearchIndex([job('a', 'Backend Senior'), job('b', 'Designer')])
  assert.deepEqual(actions().sort(), ['delete', 'index'])
  const deleted = bulkLines().map((l) => JSON.parse(l)).find((l) => l.delete)
  assert.equal(deleted.delete._id, jobSearchKey(job('c', 'Tester')))
  assert.equal(sweeps(), 0)
})
