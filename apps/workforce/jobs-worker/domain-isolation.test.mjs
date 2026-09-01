import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const worker = await readFile(new URL('./worker.ts', import.meta.url), 'utf8')
const queue = await readFile(new URL('../shared/jobs/jobsPgQueue.ts', import.meta.url), 'utf8')

test('vacancy and CV workers claim only their own task type', () => {
  assert.match(worker, /ALLOWED_TASK_TYPES/)
  assert.match(worker, /jobs\.refresh\.source/)
  assert.match(worker, /hiring\.refresh\.channel/)
  assert.match(queue, /type = ANY\(\$2::text\[\]\)/)
})

test('each domain advances only its own scheduler', () => {
  assert.match(queue, /jobsEnabled && due\(state\.jobs_due_at\)/)
  assert.match(queue, /hiringEnabled && due\(state\.hiring_due_at\)/)
  assert.match(worker, /jobsEnabled: WORKFORCE_DOMAIN === 'vacancies'/)
  assert.match(worker, /hiringEnabled: WORKFORCE_DOMAIN === 'cv'/)
})
