import assert from 'node:assert/strict'
import test from 'node:test'

import { crawlCyclic, crawlCursor, enrichDetails } from '../src/index.ts'

class MemoryState {
  values = new Map()

  async get(key) {
    return this.values.get(key) ?? null
  }

  async set(key, value) {
    this.values.set(key, value)
    return 'OK'
  }
}

const itemKey = (item) => item.id
const silentLogger = { warn() {} }

function base(state, key) {
  return {
    state,
    key,
    namespace: 'jobs:board',
    itemKey,
    requestDelayMs: 0,
    logger: silentLogger,
  }
}

test('numbered crawl ignores legacy page caps and runs to the semantic boundary', async () => {
  const state = new MemoryState()
  const pages = new Map([
    [1, [{ id: 'new' }]],
    [2, [{ id: 'fresh-2' }]],
    [3, [{ id: 'old-boundary' }]],
    [4, [{ id: 'must-not-read' }]],
  ])

  const result = await crawlCyclic({
    ...base(state, 'board'),
    pagesPerRun: 1,
    maxPage: 2,
    fetchPage: async (page) => page,
    parsePage: (page) => pages.get(page) || [],
    shouldStop: (items) => items.some((item) => item.id === 'old-boundary'),
    stopOnRepeatedPage: true,
  })

  assert.deepEqual(result.pages, [1, 2, 3])
  assert.equal(result.nextPage, 2)
  assert.equal(result.cycle, 1)
  assert.equal(result.reachedEnd, true)
  assert.deepEqual(result.items.map(itemKey), ['new', 'fresh-2', 'old-boundary'])
  assert.ok(state.values.has('jobs:board-cursor:v1:board'))
})

test('entity acceptance is independent from traversal boundary', async () => {
  const state = new MemoryState()
  const result = await crawlCyclic({
    ...base(state, 'types'),
    fetchPage: async (page) => page,
    parsePage: (page) => page === 1
      ? [{ id: 'candidate', kind: 'candidate' }, { id: 'vacancy', kind: 'vacancy' }]
      : [{ id: 'old', kind: 'vacancy', old: true }],
    acceptItem: (item) => item.kind === 'vacancy',
    shouldStop: (items) => items.some((item) => item.old),
  })

  assert.deepEqual(result.pages, [1, 2])
  assert.deepEqual(result.items.map(itemKey), ['vacancy', 'old'])
  assert.equal(result.reachedEnd, true)
})

test('repeated historical page ends the cycle without duplicating items', async () => {
  const state = new MemoryState()
  const result = await crawlCyclic({
    ...base(state, 'repeat'),
    fetchPage: async (page) => page,
    parsePage: () => [{ id: 'same' }],
    stopOnRepeatedPage: true,
  })

  assert.deepEqual(result.pages, [1])
  assert.deepEqual(result.items.map(itemKey), ['same'])
  assert.equal(result.reachedEnd, true)
  assert.equal(result.nextPage, 2)
  assert.equal(result.cycle, 1)
})

test('historical failure preserves the failed page for the next run', async () => {
  const state = new MemoryState()
  const result = await crawlCyclic({
    ...base(state, 'retry'),
    fetchPage: async (page) => {
      if (page === 2) throw new Error('temporary')
      return page
    },
    parsePage: (page) => [{ id: `page-${page}` }],
  })

  assert.deepEqual(result.pages, [1])
  assert.equal(result.nextPage, 2)
  assert.equal(result.cycle, 0)
  assert.equal(result.reachedEnd, false)
  const saved = JSON.parse(state.values.get('jobs:board-cursor:v1:retry'))
  assert.equal(saved.nextPage, 2)
})

test('opaque cursor crawl ignores legacy run caps and reaches natural end', async () => {
  const state = new MemoryState()
  const responses = new Map([
    [null, { items: [{ id: 'a', value: 1 }], next: 'p2' }],
    ['p2', { items: [{ id: 'a', value: 2 }, { id: 'b' }], next: 'p3' }],
    ['p3', { items: [{ id: 'c' }], next: null }],
  ])

  const result = await crawlCursor({
    ...base(state, 'opaque'),
    pagesPerRun: 1,
    fetchPage: async (cursor) => responses.get(cursor),
    parsePage: (raw) => raw.items,
    nextCursor: (raw) => raw.next,
  })

  assert.deepEqual(result.cursors, [null, 'p2', 'p3'])
  assert.equal(result.reachedEnd, true)
  assert.equal(result.cycle, 1)
  assert.equal(result.nextCursor, 'p2')
  assert.deepEqual(result.items.map(itemKey), ['a', 'b', 'c'])
  assert.equal(result.items[0].value, 2)
  assert.ok(state.values.has('jobs:board-opaque-cursor:v1:opaque'))
})

test('opaque cursor failure preserves the failed cursor for retry', async () => {
  const state = new MemoryState()
  const result = await crawlCursor({
    ...base(state, 'opaque-retry'),
    fetchPage: async (cursor) => {
      if (cursor === 'p2') throw new Error('temporary')
      return { items: [{ id: 'head' }], next: 'p2' }
    },
    parsePage: (raw) => raw.items,
    nextCursor: (raw) => raw.next,
  })

  assert.deepEqual(result.cursors, [null])
  assert.equal(result.reachedEnd, false)
  assert.equal(result.nextCursor, 'p2')
  const saved = JSON.parse(state.values.get('jobs:board-opaque-cursor:v1:opaque-retry'))
  assert.equal(saved.nextCursor, 'p2')
})

test('detail enrichment preserves summaries when a detail request fails', async () => {
  const state = new MemoryState()
  const items = [{ id: 'one' }, { id: 'one' }, { id: 'two' }]
  const result = await enrichDetails({
    ...base(state, 'details'),
    items,
    fetchDetail: async (item) => {
      if (item.id === 'two') throw new Error('blocked')
      return { title: 'Full' }
    },
    parseDetail: (raw, summary) => ({ ...summary, ...raw }),
  })

  assert.deepEqual(result, [{ id: 'one', title: 'Full' }, { id: 'two' }])
})
