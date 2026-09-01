import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fetchWithSourceExecutionPolicy,
  sourceRequestSignal,
  STANDARD_SOURCE_EXECUTION_POLICY,
} from '../src/executionPolicy.ts'

test('standard source execution policy owns transport mechanics only', () => {
  assert.deepEqual(STANDARD_SOURCE_EXECUTION_POLICY, {
    concurrency: 10,
    requestTimeoutMs: 6_000,
  })
  assert.equal('maxItemsPerSource' in STANDARD_SOURCE_EXECUTION_POLICY, false)
  assert.equal('maxPage' in STANDARD_SOURCE_EXECUTION_POLICY, false)
  assert.equal('pagesPerRun' in STANDARD_SOURCE_EXECUTION_POLICY, false)
})

test('shared fetch policy preserves caller cancellation and adds the common deadline', async () => {
  const caller = new AbortController()
  let observedSignal
  const response = await fetchWithSourceExecutionPolicy(
    'https://example.test/source',
    { signal: caller.signal },
    async (_input, init) => {
      observedSignal = init?.signal
      return new Response('ok')
    },
  )

  assert.equal(await response.text(), 'ok')
  assert.ok(observedSignal instanceof AbortSignal)
  assert.equal(observedSignal.aborted, false)
  caller.abort()
  assert.equal(observedSignal.aborted, true)
})

test('shared source request signal always uses a bounded transport deadline', () => {
  const signal = sourceRequestSignal()
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false)
})
