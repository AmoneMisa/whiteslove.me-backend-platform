import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const sourceModules = [
  'sources/aviationExpansionJobs.ts',
  'sources/communityJobBoardSources.ts',
  'sources/coreCompanyJobTargets.ts',
  'sources/curatedRemoteJobBoardTargets.ts',
  'sources/expandedRegionalRemoteSources.ts',
  'sources/extraPublicJobSources.ts',
  'sources/hhJobSource.ts',
  'sources/intelliasJobs.ts',
  'sources/jobsUaSource.ts',
  'sources/linkedinSource.ts',
  'sources/publicJobBoardTargets.ts',
  'sources/regionalGeneralEmployerSources.ts',
  'sources/regionalJobBoardSources.ts',
  'sources/regionalServiceJobSources.ts',
  'sources/regionalTechCompanySources.ts',
  '../server/vacancies/sources/socialJobSources.ts',
  'sources/sourceExpansionJobs.ts',
  'sources/sources.ts',
  'sources/standardJobSourceTargets.ts',
  '../server/vacancies/sources/telegramJobTargets.ts',
  'sources/ukraineJobSources.ts',
  'sources/usaTechCompanySources.ts',
  'sources/usaVisaSponsorSource.ts',
]

const hiringTransportModules = [
  '../server/hiring/sources/socialRefresh.ts',
  '../server/hiring/sources/web/http.ts',
  '../server/hiring/sources/secondary/http.ts',
]

const hiringCrawlerModules = [
  '../server/hiring/sources/web/crawler.ts',
  '../server/hiring/sources/web/uzJobs.ts',
  '../server/hiring/sources/secondary/novaRobota.ts',
  '../server/hiring/sources/secondary/layboard.ts',
  '../server/hiring/sources/linkedinVoyager.ts',
  '../server/hiring/sources/linkedInRefresh.ts',
  '../shared/hiring/sources/ishBorCrawler.ts',
  '../shared/hiring/sources/uzJobsCrawler.ts',
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
    const path = filename.startsWith('../') ? filename : `../server/utils/${filename}`
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    for (const [label, pattern] of forbiddenExecutionPolicy) {
      assert.doesNotMatch(source, pattern, `${filename} contains ${label}; execution policy belongs to the shared crawler/queue worker`)
    }
  }
})

test('hiring transports do not own result/depth caps or local deadlines', async () => {
  for (const path of hiringTransportModules) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    for (const [label, pattern] of forbiddenExecutionPolicy) {
      assert.doesNotMatch(source, pattern, `${path} contains ${label}; execution policy belongs to crawler-core`)
    }
    assert.doesNotMatch(source, /\blimit\s*:\s*\d+/u, `${path} contains a source-local numeric result limit`)
  }

  const social = await readFile(new URL('../server/hiring/sources/socialRefresh.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(social, /maxItemsPerSource/u)
  assert.doesNotMatch(social, /\.slice\(0,\s*limit\)/u)
  assert.doesNotMatch(social, /HIRING_SOCIAL_API_URL|QUEUE_INTERNAL_KEY|internal\/social/u)
  assert.match(social, /socialFetcherBaseUrl\(\)\}\/crawl/u)
})

test('hiring crawlers use shared transport policy and semantic page boundaries', async () => {
  for (const path of hiringCrawlerModules) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    for (const [label, pattern] of forbiddenExecutionPolicy) {
      assert.doesNotMatch(source, pattern, `${path} contains ${label}; execution policy belongs to crawler-core`)
    }
  }
})

test('shared crawler traversal is semantic rather than count/page bounded', async () => {
  const crawler = await readFile(new URL('../packages/crawler-core/src/index.ts', import.meta.url), 'utf8')
  const facade = await readFile(new URL('../server/utils/sources/cyclicJobBoardCrawler.ts', import.meta.url), 'utf8')

  assert.match(crawler, /shouldStop/u)
  assert.match(crawler, /acceptItem/u)
  assert.doesNotMatch(crawler, /STANDARD_CRAWL_POLICY[\s\S]*pagesPerRun:\s*\d+/u)
  assert.doesNotMatch(crawler, /STANDARD_CRAWL_POLICY[\s\S]*maxPage:\s*\d+/u)
  assert.match(facade, /shouldStop:\s*reachedJobDateBoundary/u)
  assert.match(facade, /acceptItem:\s*isVacancy/u)
  assert.match(facade, /crawlStandardJobBoard/u)
  assert.match(facade, /crawlStandardCursorJobBoard/u)
  assert.match(facade, /enrichStandardJobBoardDetails/u)
})

test('jobs worker schedules queue targets instead of a second aggregate refresh path', async () => {
  const runtime = await readFile(new URL('../jobs-worker/jobsRuntime.ts', import.meta.url), 'utf8')
  const refresh = await readFile(new URL('../server/vacancies/application/jobsSourceRefresh.ts', import.meta.url), 'utf8')
  const directFetcher = await readFile(new URL('../server/utils/sources/jobSourceFetchers.ts', import.meta.url), 'utf8')

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
