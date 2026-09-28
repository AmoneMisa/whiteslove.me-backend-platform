import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { communityJobBoardHosts } from '../jobs-worker/jobsRuntime.ts'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const bare = (host) => host.toLowerCase().replace(/^www\./, '')

test('every host the worker falls back for is one the browser fetcher accepts', async () => {
  const worker = await read('../jobs-worker/worker.ts')
  const listed = worker.slice(worker.indexOf('const hosts = new Set(['), worker.indexOf('...communityJobBoardHosts()'))
  const workerHosts = new Set([...listed.matchAll(/'([a-z0-9.-]+)'/g)].map((m) => m[1]).concat(communityJobBoardHosts()).map(bare))

  const app = await read('../../../services/job-browser-fetcher/app.py')
  const defaults = app.slice(app.indexOf('DEFAULT_ALLOWED_HOSTS = {'), app.indexOf('EXTRA_ALLOWED_HOSTS'))
  const compose = await read('../../../docker-compose.yml')
  const extra = (compose.match(/JOB_BROWSER_ALLOWED_HOSTS: \$\{JOB_BROWSER_ALLOWED_HOSTS:-([^}]*)\}/) || [])[1] || ''
  const fetcherHosts = new Set([...defaults.matchAll(/"([a-z0-9.-]+)"/g)].map((m) => m[1]).concat(extra.split(',')).map(bare))

  // A host missing from the fetcher makes every fallback answer "URL host is
  // not allowed", so the board is never actually retried through the browser.
  const refused = [...workerHosts].filter((host) => !fetcherHosts.has(host)).sort()
  assert.deepEqual(refused, [])
})
