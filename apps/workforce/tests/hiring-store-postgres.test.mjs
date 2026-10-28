import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

process.env.SITE_STATE_DIR = process.env.SITE_STATE_DIR || '/tmp/hiring-store-test'
delete process.env.HIRING_DATABASE_URL

const database = await import('../server/hiring/infrastructure/database.ts')
const exporter = await import('../server/hiring/application/candidateSnapshotExport.ts')
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('the candidate store is the snapshot unless HIRING_STORE says otherwise and a database is configured', () => {
  delete process.env.HIRING_STORE
  delete process.env.HIRING_READ_STORE
  assert.equal(database.hiringStoreFromDatabase(), false)
  assert.equal(database.hiringReadFromDatabase(), false)
  process.env.HIRING_STORE = 'postgres'
  process.env.HIRING_READ_STORE = 'postgres'
  assert.equal(database.hiringStoreFromDatabase(), false, 'no database configured')
  process.env.HIRING_DATABASE_URL = 'postgresql://user@localhost/none'
  assert.equal(database.hiringStoreFromDatabase(), true)
  assert.equal(database.hiringReadFromDatabase(), true)
  process.env.HIRING_READ_STORE = 'snapshot'
  assert.equal(database.hiringReadFromDatabase(), false, 'the two switches are independent')
  delete process.env.HIRING_STORE
  delete process.env.HIRING_READ_STORE
  delete process.env.HIRING_DATABASE_URL
})

test('a candidate is identified the way the table is unique on it', () => {
  assert.equal(database.candidateIdentity({ source: 'Telegram', country: 'uz', id: '42' }), 'telegram:UZ:42')
  assert.equal(database.candidateIdentity({ id: 7 }), 'telegram::7')
})

test('the candidate snapshot is exported page by page and parses as the array of current candidates', async () => {
  const all = Array.from({ length: 2300 }, (_, i) => ({ id: String(i + 1), name: `Name ${i}`, ai: i % 7 ? undefined : { status: 'completed' } }))
  const page = async (after, limit) => {
    const profiles = all.filter((profile) => Number(profile.id) > after).slice(0, limit)
    return { profiles, lastId: profiles.length ? Number(profiles[profiles.length - 1].id) : after }
  }
  let text = ''
  for await (const piece of exporter.candidateSnapshotPieces(page)) text += piece
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(all)), 'what a JSON round trip keeps')
  await assert.rejects(
    async () => { for await (const piece of exporter.candidateSnapshotPieces(async (after) => ({ profiles: [], lastId: after }))) void piece },
    /no current candidates/,
    'an empty table is not published over the old snapshot',
  )
})

test('without a configured database the incremental candidate reads do nothing', async () => {
  delete process.env.HIRING_DATABASE_URL
  assert.equal((await database.loadDbCandidateAiState([{ source: 'telegram', country: 'UZ', id: '1' }])).size, 0)
  assert.deepEqual(await database.listDbCandidatesNeedingAi(10), [])
  assert.equal(await database.getDbCandidateByIdentity({ source: 'telegram', country: 'UZ', id: '1' }), null)
  assert.equal(await database.getDbCandidateByIdOrUrl('x'), null)
  assert.deepEqual(await database.listDbCandidatesPage(0, 10), { profiles: [], lastId: 0 })
  assert.equal(await database.countDbCandidates(), 0)
  assert.equal(await database.upsertDbCandidates([{ id: '1' }], 'handle'), 0)
})

test('the writers branch before touching the snapshot, and the search index is told only what was written', async () => {
  const writer = await read('server/hiring/application/candidateSnapshotWriter.ts')
  const entry = writer.indexOf('export async function persistTelegramCandidates(')
  assert.ok(writer.indexOf('hiringStoreFromDatabase()', entry) > entry)
  assert.ok(writer.indexOf('persistTelegramCandidatesToPostgres(profiles, diagnostic)', entry) < writer.indexOf('await loadStored()', entry))
  assert.match(writer, /await indexCandidatesIncremental\(profiles\)/)
  const web = await read('server/hiring/webProfilePersistence.ts')
  const webEntry = web.indexOf('export async function persistWebProfiles(')
  assert.ok(web.indexOf('hiringStoreFromDatabase()', webEntry) > webEntry)
  assert.ok(web.indexOf('persistWebProfilesToPostgres(profiles, diagnostic)', webEntry) < web.indexOf('useStateStore().get(STORE_KEY)', webEntry))
  const elastic = await read('server/utils/hiring/hiringElastic.ts')
  const incremental = elastic.slice(elastic.indexOf('export async function indexCandidatesIncremental'), elastic.indexOf('export async function reconcileCandidateIndex'))
  assert.doesNotMatch(incremental, /_delete_by_query/, 'adding a few candidates must not sweep the index')
  const preview = await read('server/utils/support/sharePreview.ts')
  assert.ok(preview.indexOf('hiringReadFromDatabase()') < preview.indexOf('getStoredCvProfilesSnapshot()'))
})

test('the database layer stays DDL-free and the write was split without changing what it does', async () => {
  const db = await read('server/hiring/infrastructure/database.ts')
  assert.doesNotMatch(db, /\b(?:CREATE|ALTER)\s+(?:SCHEMA|TABLE|INDEX)\b/i)
  const save = db.slice(db.indexOf('export async function saveDbCandidates('), db.indexOf('// ---- the incremental store'))
  assert.match(save, /await writeCandidateRows\(profiles, diagnostic\.handle\)\s+await recordDbSourceRun\(diagnostic\)/)
  const write = db.slice(db.indexOf('async function writeCandidateRows('), db.indexOf('/** Write candidates without recording a source run'))
  assert.match(write, /syncCurrentCandidateKeys\(client, schema\(\)/)
  assert.match(write, /hiringStatsCache\.clear\(\)/)
})
