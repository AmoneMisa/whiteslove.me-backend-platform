import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const sourceModules = [
  'aviationExpansionJobs.ts',
  'communityJobBoardSources.ts',
  'coreCompanyJobTargets.ts',
  'curatedRemoteJobBoardTargets.ts',
  'expandedRegionalRemoteSources.ts',
  'extraPublicJobSources.ts',
  'hhJobSource.ts',
  'intelliasJobs.ts',
  'jobsUaSource.ts',
  'linkedinSource.ts',
  'publicJobBoardTargets.ts',
  'regionalGeneralEmployerSources.ts',
  'regionalJobBoardSources.ts',
  'regionalServiceJobSources.ts',
  'regionalTechCompanySources.ts',
  'socialJobSources.ts',
  'sourceExpansionJobs.ts',
  'sources.ts',
  'standardJobSourceTargets.ts',
  'telegramJobTargets.ts',
  'ukraineJobSources.ts',
  'usaTechCompanySources.ts',
  'usaVisaSponsorSource.ts',
]

const hiringTransportModules = [
  '../server/hiring/sources/socialRefresh.ts',
  '../server/hiring/sources/web/http.ts',
  '../server/hiring/sources/secondary/http.ts',
]

const forbiddenExecutionPolicy = [
  ['AbortSignal.timeout', /AbortSignal\.timeout\s*\(/u],
  ['Promise.all', /Promise\.all(?:Settled)?\s*\(/u],
  ['local concurrency constant', /\b(?:FETCH_|REQUEST_|DETAIL_|SOURCE_|JOB_)?CONCURRENCY\b/u],
  ['local timeout constant', /\b(?:FETCH_|REQUEST_|DETAIL_|SOURCE_|JOB_)?TIMEOUT(?:_MS)?\b/u],
  ['local batch-size constant', /\b(?:FETCH_|REQUEST_|DETAIL_|SOURCE_|JOB_)?BATCH_SIZE\b/u],
  ['local max-pages constant', /\b(?:FETCH_|REQUEST_|DETAIL_|SOURCE_|JOB_)?MAX_PAGES?\b/u],
  ['local pages-per-run constant', /\b(?:FETCH_|REQUEST_|DETAIL_|SOURCE_|JOB_)?PAGES_PER_RUN\b/u],
  ['local request-delay constant', /\b(?:FETCH_|REQUEST_|DETAIL_|SOURCE_|JOB_)?REQUEST_DELAY(?:_MS)?\b/u],
]

test('vacancy source adapters do not own crawler execution policy or broad fan-out', async () => {
  for (const filename of sourceModules) {
    const source = await readFile(new URL(`../server/utils/${filename}`, import.meta.url), 'utf8')
    for (const [label, pattern] of forbiddenExecutionPolicy) {
      assert.doesNotMatch(source, pattern, `${filename} contains ${label}; execution policy belongs to the shared crawler/queue worker`)
    }
  }
})

test('hiring transports consume shared execution policy instead of owning limits or deadlines', async () => {
  for (const path of hiringTransportModules) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    for (const [label, pattern] of forbiddenExecutionPolicy) {
      assert.doesNotMatch(source, pattern, `${path} contains ${label}; execution policy belongs to crawler-core`)
    }
    assert.doesNotMatch(source, /\blimit\s*:\s*\d+/u, `${path} contains a source-local numeric result limit`)
  }

  const social = await readFile(new URL('../server/hiring/sources/socialRefresh.ts', import.meta.url), 'utf8')
  assert.match(social, /STANDARD_SOURCE_EXECUTION_POLICY\.maxItemsPerSource/u)
  assert.match(social, /fetchWithSourceExecutionPolicy\(endpoint/u)
})

test('shared crawler remains the only vacancy adapter traversal policy', async () => {
  const crawler = await readFile(new URL('../server/utils/cyclicJobBoardCrawler.ts', import.meta.url), 'utf8')
  assert.match(crawler, /STANDARD_JOB_BOARD_CRAWL_POLICY/u)
  assert.match(crawler, /crawlStandardJobBoard/u)
  assert.match(crawler, /crawlStandardCursorJobBoard/u)
  assert.match(crawler, /enrichStandardJobBoardDetails/u)
})

test('jobs worker schedules queue targets instead of a second aggregate refresh path', async () => {
  const runtime = await readFile(new URL('../jobs-worker/jobsRuntime.ts', import.meta.url), 'utf8')
  const refresh = await readFile(new URL('../server/utils/jobsSourceRefresh.ts', import.meta.url), 'utf8')
  const directFetcher = await readFile(new URL('../server/utils/jobSourceFetchers.ts', import.meta.url), 'utf8')

  assert.match(runtime, /return configuredJobRefreshTargets\(\)/u)
  assert.match(runtime, /return refreshJobTarget\(source\)/u)
  assert.match(refresh, /TARGETIZED_SOURCES/u)
  assert.match(refresh, /reason: 'use_queue_targets'/u)
  assert.doesNotMatch(directFetcher, /fetch(?:LinkedIn|Facebook|Threads|Companies|Hh|IshGo|ItJobsUz|Olx|Rss)\b/u)

  await assert.rejects(
    access(new URL('../server/utils/jobsStore.ts', import.meta.url)),
    (error) => error?.code === 'ENOENT',
  )
})
