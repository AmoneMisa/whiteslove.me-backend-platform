import assert from 'node:assert/strict'
import test from 'node:test'

const {
  COMMUNITY_JOB_BOARDS,
  COMMUNITY_JOB_BOARD_TARGET_PREFIX,
  configuredCommunityJobBoardTargets,
  isCommunityJobBoardTarget,
} = await import('../server/utils/sources/communityJobBoardSources.ts')

const { STANDARD_JOB_BOARD_CRAWL_POLICY } = await import('../server/utils/sources/cyclicJobBoardCrawler.ts')

test('community board registry exposes one durable queue target per board', () => {
  const targets = configuredCommunityJobBoardTargets()
  const keys = COMMUNITY_JOB_BOARDS.map((board) => board.key)

  assert.equal(new Set(keys).size, keys.length)
  assert.equal(targets.length, COMMUNITY_JOB_BOARDS.length + 1) // + Himalayas cursor feed
  assert.ok(targets.every((target) => target.startsWith(COMMUNITY_JOB_BOARD_TARGET_PREFIX)))
  assert.ok(targets.every((target) => isCommunityJobBoardTarget(target)))

  for (const required of [
    'indeed',
    'we-work-remotely',
    'hiring-cafe',
    'remotejobfor-me',
    'sydicom',
    'turing',
    'braintrust',
    'upwork',
    'dribbble',
    'proz',
    'airbus',
    'siemens',
    'quantco',
    'wypoon',
    'neworbit',
    'sunrise-greenhouse',
  ]) {
    assert.ok(targets.includes(`${COMMUNITY_JOB_BOARD_TARGET_PREFIX}${required}`), required)
  }
  assert.ok(targets.includes(`${COMMUNITY_JOB_BOARD_TARGET_PREFIX}himalayas`))
})

test('standard crawler policy centralizes pacing without count or page completion caps', () => {
  assert.deepEqual(STANDARD_JOB_BOARD_CRAWL_POLICY, {
    requestDelayMs: 500,
  })
  assert.equal('pagesPerRun' in STANDARD_JOB_BOARD_CRAWL_POLICY, false)
  assert.equal('maxPage' in STANDARD_JOB_BOARD_CRAWL_POLICY, false)
  assert.equal('requestTimeoutMs' in STANDARD_JOB_BOARD_CRAWL_POLICY, false)
  assert.equal('concurrency' in STANDARD_JOB_BOARD_CRAWL_POLICY, false)
  assert.equal('maxJobsPerSource' in STANDARD_JOB_BOARD_CRAWL_POLICY, false)
})
