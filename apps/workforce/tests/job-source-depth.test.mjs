import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { reachedJobDateBoundary } from '../server/utils/sources/cyclicJobBoardCrawler.ts'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const day = 86_400_000
const job = (ageDays) => ({ postedAt: new Date(Date.now() - ageDays * day).toISOString() })

test('a pinned old ad does not end the crawl; a fully stale page does', () => {
  // arbeitnow page 1: current postings plus one promoted August ad.
  assert.equal(reachedJobDateBoundary([job(0), job(1), job(47)]), false)
  assert.equal(reachedJobDateBoundary([job(15), job(20)]), true)
  // Undated postings never prove the boundary, and neither does an empty page.
  assert.equal(reachedJobDateBoundary([{ postedAt: 'unknown' }, job(30)]), false)
  assert.equal(reachedJobDateBoundary([]), false)
})

test('paged sources traverse through the shared crawler instead of one page', async () => {
  const uz = await read('server/utils/sources/standardJobSourceTargets.ts')
  // ishGO's HTML renders only 20; its public API pages the ~430 active ones.
  assert.match(uz, /const ISHGO_SEARCH_URL = 'https:\/\/api\.ishgo\.uz\/api\/rest\/entities\/Vacancy\/search'/)
  assert.match(uz, /sort: '-createdDate'/)
  assert.match(uz, /const run = await crawlStandardJobBoard\(\{\s+key: `source:\$\{source\}`,/)
  assert.doesNotMatch(uz, /const listing = await fetchText\(config\.listingUrl\)/)
  const feeds = await read('server/utils/sources/sources.ts')
  assert.match(feeds, /fetchPage: \(page\) => fetchText\(`https:\/\/www\.arbeitnow\.com\/api\/job-board-api\?page=\$\{page\}`\)/)
})

test('an undated IT-Jobs.uz summary is not published as a fresh posting', async () => {
  const uz = await read('server/utils/sources/standardJobSourceTargets.ts')
  assert.match(uz, /return config\.source === 'ishgo' \? summary : null/)
})
