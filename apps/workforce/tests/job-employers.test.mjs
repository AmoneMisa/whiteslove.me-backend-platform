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
