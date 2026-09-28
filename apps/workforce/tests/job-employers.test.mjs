import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  MIN_EMPLOYER_ROLES,
  jobEmployerKey,
  parseJobEmployerKey,
} from '../shared/hiring/jobEmployer.ts'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('one company is one employer however its name is written', () => {
  const canonical = jobEmployerKey('UZ', 'Acme LLC')
  assert.equal(jobEmployerKey('UZ', 'ACME, LLC.'), canonical)
  assert.equal(jobEmployerKey('UZ', 'acme'), canonical)
  // Country is part of the identity: the same brand hiring in two countries is
  // two employers to a jobseeker.
  assert.notEqual(jobEmployerKey('KZ', 'Acme LLC'), canonical)
  // Nothing to group by.
  assert.equal(jobEmployerKey('UZ', ''), null)
  assert.equal(jobEmployerKey('UZ', '   '), null)
})

test('a key round-trips to the identity it stands for', () => {
  const key = jobEmployerKey('UZ', 'Acme LLC')
  assert.deepEqual(parseJobEmployerKey(key), { country: 'UZ', company: 'acme' })
  // A country-less posting still groups, just without a country.
  assert.deepEqual(parseJobEmployerKey(jobEmployerKey('', 'Acme')), { country: '', company: 'acme' })
})

test('a hand-edited key is rejected rather than matching nothing', () => {
  for (const bad of [null, undefined, '', 'not base64!', Buffer.from('UZ').toString('base64url')]) {
    assert.equal(parseJobEmployerKey(bad), null, String(bad))
  }
  // Decodes, but the company half is not normalised, so it is not a key we
  // would ever have produced.
  const unnormalised = Buffer.from('UZ:Acme LLC', 'utf8').toString('base64url')
  assert.equal(parseJobEmployerKey(unnormalised), null)
  // Decodes, but the country half is not a country code.
  const badCountry = Buffer.from('UZBEK:acme', 'utf8').toString('base64url')
  assert.equal(parseJobEmployerKey(badCountry), null)
})

test('a collection is 2+ different live roles, not 2+ postings', async () => {
  assert.equal(MIN_EMPLOYER_ROLES, 2)
  const runtime = await read('server/jobs/infrastructure/database.ts')
  // Roles are distinct clusters: a vacancy reposted weekly stays one role.
  assert.match(runtime, /COUNT\(DISTINCT v\.cluster_key\)::int AS roles/u)
  assert.match(runtime, /HAVING COUNT\(DISTINCT v\.cluster_key\) >= \$2/u)
  // Only live postings count, and unattributable ones are excluded.
  assert.match(runtime, /WHERE v\.active = TRUE\s+AND v\.cluster_key IS NOT NULL/u)
  // Below the threshold there is no collection to show.
  assert.match(runtime, /rows\[0\]\.roles < MIN_EMPLOYER_ROLES\) return null/u)
})

test('one employer page uses SQL PostgreSQL accepts, scoped to its own country', async () => {
  const runtime = await read('server/jobs/infrastructure/database.ts')
  // PostgreSQL rejects DISTINCT inside a window function ("DISTINCT is not
  // implemented for window functions"); the read would throw, be caught, and
  // every employer page would come back empty.
  assert.doesNotMatch(runtime, /COUNT\(DISTINCT[^)]*\)\s*OVER/u)
  assert.match(runtime, /COUNT\(DISTINCT cluster_key\)::int AS roles\s+FROM live/u)
  // A country-less key means NULL country, not every country, so the page
  // lists exactly what the list grouped under that key.
  assert.match(runtime, /AND COALESCE\(v\.country, ''\) = \$2/u)
  assert.doesNotMatch(runtime, /\$2 = '' OR v\.country = \$2/u)
})

test('the employer routes are registered and answer with data, not throws', async () => {
  const server = await read('api/server.ts')
  assert.match(server, /'\/jobs-employers', employers\.default/u)
  assert.match(server, /'\/jobs-employer', employer\.default/u)
  // api/server.ts turns any throw into a bare 500, and h3-compat provides no
  // createError, so these routes report emptiness as data.
  for (const path of ['server/routes/jobs-employers.get.ts', 'server/routes/jobs-employer.get.ts']) {
    const route = await read(path)
    assert.doesNotMatch(route, /createError/u, path)
  }
})

test('the aggregate has indexes that match its predicates', async () => {
  const migration = await read('db/migrations/jobs/003_job_employers.sql')
  // Partial on the same predicate as the query, so closed vacancies stay out.
  assert.match(migration, /ON \{\{schema\}\}\.vacancies \(country, cluster_key\)\s+WHERE active = TRUE AND cluster_key IS NOT NULL/u)
  assert.match(migration, /ON \{\{schema\}\}\.job_clusters \(company_normalized, country\)/u)
})

test('the vacancy sync writes the clusters employer collections read', async () => {
  // Without this nothing ever set cluster_key or filled job_clusters, so every
  // employer list and page was empty in production.
  const runtime = await read('server/jobs/infrastructure/database.ts')
  assert.match(runtime, /cluster_key: clusterOf\(job\)\?\.key \?\? null,/u)
  assert.match(runtime, /search_text = EXCLUDED\.search_text, cluster_key = EXCLUDED\.cluster_key,/u)
  assert.match(runtime, /INSERT INTO \$\{name\}\.job_clusters \(/u)
  // Clusters go in before the vacancies that refer to them.
  assert.ok(runtime.indexOf('CLUSTER_UPSERT_SQL(schema())') < runtime.indexOf('UPSERT_SQL(schema()), [toPostgresJson(rows'))
})

test('the stored cluster parts are the ones the key hashes', async () => {
  const { jobClusterIdentity, jobClusterKey } = await import('../shared/hiring/jobCluster.ts')
  const job = { company: 'ACME, LLC.', title: 'Senior Backend Engineer (Remote)', city: 'Tashkent', country: 'uz' }
  const identity = jobClusterIdentity(job)
  assert.equal(identity.key, jobClusterKey(job))
  assert.deepEqual({ ...identity, key: undefined }, { key: undefined, country: 'UZ', company: 'acme', title: 'backend engineer', locality: 'tashkent' })
  assert.equal(jobClusterIdentity({ company: '', title: 'x' }), null)
})

test('one bad character no longer fails a whole database sync', async () => {
  const { toPostgresJson } = await import('../shared/postgresJson.ts')
  const emoji = '\u{1F680}'
  const brokenEmoji = emoji.slice(0, 1) // half an emoji, as truncation leaves it
  const text = toPostgresJson({ title: `Rocket ${brokenEmoji} role`, tail: emoji.slice(1), nul: 'a\u0000b', ok: `fine ${emoji}`, n: 3 })
  // PostgreSQL rejects \udXXX escapes of unpaired surrogates and \u0000.
  assert.doesNotMatch(text, /\\ud[89a-f][0-9a-f]{2}|\\u0000/i)
  assert.deepEqual(JSON.parse(text), { title: 'Rocket � role', tail: '�', nul: 'ab', ok: `fine ${emoji}`, n: 3 })
  for (const path of ['server/jobs/infrastructure/database.ts', 'server/hiring/infrastructure/database.ts']) {
    const source = await read(path)
    assert.doesNotMatch(source, /query\([^)]*\[JSON\.stringify\(/u, path)
  }
})

test('board placeholders are not employers, pseudo-countries are', async () => {
  const { isPlaceholderCompany } = await import('../shared/hiring/jobEmployer.ts')
  for (const name of ['Djinni employer', 'Work.ua employer', 'Flagma UZ employer', 'Freelancer employer']) {
    assert.equal(isPlaceholderCompany(name), true, name)
  }
  for (const name of ['Stripe', 'Datadog', 'Employers Holdings Inc']) {
    assert.equal(isPlaceholderCompany(name), false, name)
  }
  // 6,958 live vacancies carry REMOTE or OTHER; their employers need pages.
  assert.deepEqual(parseJobEmployerKey(jobEmployerKey('REMOTE', 'Acme')), { country: 'REMOTE', company: 'acme' })
  assert.deepEqual(parseJobEmployerKey(jobEmployerKey('OTHER', 'Acme')), { country: 'OTHER', company: 'acme' })
  const boards = await read('server/utils/sources/communityJobBoardSources.ts')
  assert.match(boards, /input\.board\.directEmployer \? input\.board\.label : `\$\{input\.board\.label\} employer`/u)
  const runtime = await read('server/jobs/infrastructure/database.ts')
  assert.match(runtime, /if \(isPlaceholderCompany\(job\.company\)\) return null/u)
})
