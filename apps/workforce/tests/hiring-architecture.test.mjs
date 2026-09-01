import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('hiring application and extracted sources use canonical infrastructure paths', async () => {
  const files = [
    'server/hiring/application/readSnapshot.ts',
    'server/hiring/application/readWebProfiles.ts',
    'server/hiring/application/refreshTelegramChannel.ts',
    'server/hiring/application/candidateSnapshotWriter.ts',
    'server/hiring/sources/ishBorRefresh.ts',
    'server/hiring/sources/linkedInRefresh.ts',
    'server/hiring/sources/secondaryWebRefresh.ts',
    'server/hiring/sources/socialRefresh.ts',
    'server/hiring/sources/uzJobsRefresh.ts',
    'server/hiring/sources/webCvRefresh.ts',
  ]

  for (const path of files) {
    const source = await read(path)
    assert.doesNotMatch(source, /utils\/hiringDb|utils\/hiringStoreLock/)
  }
})

test('Telegram per-channel orchestration stays thin and delegates snapshot mutation', async () => {
  const application = await read('server/hiring/application/refreshSources.ts')
  const channelRefresh = await read('server/hiring/application/refreshTelegramChannel.ts')
  const snapshotWriter = await read('server/hiring/application/candidateSnapshotWriter.ts')

  assert.match(application, /\.\/refreshTelegramChannel/)
  assert.match(channelRefresh, /fetchHiringChannel/)
  assert.match(channelRefresh, /persistTelegramCandidates/)
  assert.doesNotMatch(channelRefresh, /useStateStore|scheduleAiExtraction|saveDbCandidates|withHiringStoreLock/)
  assert.match(snapshotWriter, /useStateStore/)
  assert.match(snapshotWriter, /scheduleAiExtraction/)
  assert.match(snapshotWriter, /withHiringStoreLock/)
})

test('hiring metadata route is runtime-neutral and does not load Telegram source code', async () => {
  const route = await read('server/routes/hiring-meta.get.ts')
  const markets = await read('shared/hiring/hiringMarkets.ts')

  assert.match(route, /shared\/hiring\/hiringMarkets/)
  assert.doesNotMatch(route, /utils\/hiringSources/)
  assert.match(markets, /UZ.*Uzbekistan/s)
  assert.match(markets, /UA.*Ukraine/s)
  assert.match(markets, /KZ.*Kazakhstan/s)
  assert.match(markets, /KG.*Kyrgyzstan/s)
})

test('legacy Telegram hiring store and facade stay removed', async () => {
  await assert.rejects(read('server/utils/hiringStore.ts'), { code: 'ENOENT' })
  await assert.rejects(read('server/hiring/sources/telegramRefresh.ts'), { code: 'ENOENT' })
})
