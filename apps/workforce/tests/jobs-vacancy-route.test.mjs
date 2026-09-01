import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const route = await readFile(new URL('../server/routes/jobs-vacancy.get.ts', import.meta.url), 'utf8')

test('jobs-vacancy keeps indexed publicId lookup with snapshot compatibility fallback', () => {
  assert.match(route, /const publicId = String\(query\.publicId \?\? ''\)\.trim\(\)/)
  assert.match(route, /getJobByPublicIdDb\(publicId\)/)
  assert.match(route, /jobs\.find\(\(job\) => String\(publicEntityId\('job', job\.source, job\.id\)\) === publicId\)/)
  assert.match(route, /jobs\.find\(\(job\) => job\.id === id \|\| job\.url === id\)/)
})
