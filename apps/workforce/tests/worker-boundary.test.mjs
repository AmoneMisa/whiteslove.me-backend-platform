import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const worker = readFileSync(new URL('../jobs-worker/worker.ts', import.meta.url), 'utf8')
const hiringRuntime = readFileSync(new URL('../jobs-worker/hiringRuntime.ts', import.meta.url), 'utf8')
const hiringAdapters = readFileSync(new URL('../jobs-worker/hiringAdapters.ts', import.meta.url), 'utf8')
const jobsRuntime = readFileSync(new URL('../jobs-worker/jobsRuntime.ts', import.meta.url), 'utf8')

test('worker orchestration uses local runtime boundaries', () => {
  assert.match(worker, /from '\.\/hiringRuntime'/)
  assert.match(worker, /from '\.\/jobsRuntime'/)
  assert.doesNotMatch(worker, /server\/utils\//)

  assert.match(hiringRuntime, /from '\.\/hiringAdapters'/)
  assert.match(hiringRuntime, /export function allHiringTargets/)
  assert.match(hiringRuntime, /export async function refreshHiringTarget/)
  assert.doesNotMatch(hiringRuntime, /server\/utils\//)

  assert.match(hiringAdapters, /export interface HiringRefreshAdapter/)
  assert.match(hiringAdapters, /export const hiringRefreshAdapters: HiringRefreshAdapter\[]/)
  assert.match(hiringAdapters, /server\/hiring\/application\/refreshSources/)

  assert.match(jobsRuntime, /export function configuredSources/)
  assert.match(jobsRuntime, /export async function refreshSource/)
})
