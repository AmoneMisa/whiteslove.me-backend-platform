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

test('cyclic crawl keeps existing cursor keys and rotates historical pages', async () => {
  const state = new MemoryState()
  const pages = new Map([
    [1, [{ id: 'new' }]],
    [2, [{ id: 'old-2' }]],
    [3, [{ id: 'old-3' }]],
    [4, []],
  ])

  const first = await crawlCyclic({
    ...base(state, 'board'),
    pagesPerRun: 2,
    maxPage: 4,
    fetchPage: async (page) => page,
    parsePage: (page) => pages.get(page) || [],
    stopOnRepeatedPage: true,
  })

  assert.deepEqual(first.pages, [1, 2, 3])
  assert.equal(first.nextPage, 4)
  assert.equal(first.cycle, 0)
  assert.equal(first.reachedEnd, false)
  assert.deepEqual(first.items.map(itemKey), ['new', 'old-2', 'old-3'])
  assert.ok(state.values.has('jobs:board-cursor:v1:board'))

  const second = await crawlCyclic({
    ...base(state, 'board'),
    pagesPerRun: 2,
    maxPage: 4,
    fetchPage: async (page) => page,
    parsePage: (page) => pages.get(page) || [],
    stopOnRepeatedPage: true,
  })

  assert.deepEqual(second.pages, [1, 4])
  assert.equal(second.nextPage, 2)
  assert.equal(second.cycle, 1)
  assert.equal(second.reachedEnd, true)
})

test('repeated historical page ends the cycle without duplicating items', async () => {
  const state = new MemoryState()
  const result = await crawlCyclic({
    ...base(state, 'repeat'),
    pagesPerRun: 2,
    maxPage: 10,
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
    pagesPerRun: 2,
    maxPage: 10,
    fetchPage: async (page) => {
      if (page === 2) throw new Error('temporary')
      return page
    },
    parsePage: (page) => [{ id: `page-${page}` }],
  })

  assert.deepEqual(result.pages, [1])
  assert.equal(result.nextPage, 2)
  assert.equal(result.cycle, 0)
  const saved = JSON.parse(state.values.get('jobs:board-cursor:v1:retry'))
  assert.equal(saved.nextPage, 2)
})

test('opaque cursor crawl resumes and deduplicates by injected item key', async () => {
  const state = new MemoryState()
  const responses = new Map([
    [null, { items: [{ id: 'a', value: 1 }], next: 'p2' }],
    ['p2', { items: [{ id: 'a', value: 2 }, { id: 'b' }], next: 'p3' }],
    ['p3', { items: [{ id: 'c' }], next: null }],
  ])

  const result = await crawlCursor({
    ...base(state, 'opaque'),
    pagesPerRun: 2,
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
