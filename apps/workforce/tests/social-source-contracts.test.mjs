import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { HIRING_FACEBOOK_GROUPS } from '../shared/hiring/sources/facebookGroups.ts'

const jobs = await readFile(new URL('../server/utils/socialJobSources.ts', import.meta.url), 'utf8')
const hiring = await readFile(new URL('../server/hiring/sources/socialRefresh.ts', import.meta.url), 'utf8')
const linkedin = await readFile(new URL('../server/hiring/sources/linkedInRefresh.ts', import.meta.url), 'utf8')
const transport = await readFile(new URL('../server/utils/socialFetcherTransport.ts', import.meta.url), 'utf8')
const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')

test('Threads vacancy discovery uses one durable target and passes the domain cutoff', () => {
  assert.match(jobs, /source:\s*'threads',\s*mode:\s*'search',\s*query:\s*target\.query,\s*cutoff/)
  assert.match(jobs, /threadsJobCoverage\(\)/)
  assert.match(jobs, /configuredSocialJobTargets/)
  assert.match(jobs, /return fetchTarget\(config\)/)
  assert.match(jobs, /socialFetcherBaseUrl\(\)\}\/crawl/)
  assert.doesNotMatch(jobs, /maxItemsPerSource|flats-api|internal\/social/)
  assert.doesNotMatch(jobs, /\blimit\s*:/)
  assert.doesNotMatch(jobs, /Promise\.all(?:Settled)?/)
})

test('candidate social discovery calls shared transport directly with its domain cutoff', () => {
  assert.match(hiring, /source:\s*'threads',\s*mode:\s*'search',\s*query:\s*target\.query,\s*cutoff/)
  assert.match(hiring, /socialFetcherBaseUrl\(\)\}\/crawl/)
  assert.doesNotMatch(hiring, /maxItemsPerSource|HIRING_SOCIAL_API_URL|QUEUE_INTERNAL_KEY|flats-api|internal\/social/)
  assert.doesNotMatch(hiring, /\blimit\s*:/)
})

test('workforce transport boundary uses the shared social-fetcher service directly', () => {
  assert.match(transport, /SOCIAL_FETCHER_URL/)
  assert.match(transport, /http:\/\/social-fetcher:4040/)
  assert.doesNotMatch(transport, /flats-social-fetcher|flats-api|internal\/social/)
  assert.match(compose, /^\s{2}social-fetcher:\s*$/m)
  assert.match(compose, /SOCIAL_FETCHER_URL:\s*http:\/\/social-fetcher:4040/u)
  assert.doesNotMatch(compose, /flats-social-fetcher|HIRING_SOCIAL_API_URL/u)
})

test('LinkedIn candidate discovery requests the dedicated public candidate mode', () => {
  assert.match(linkedin, /source:\s*'linkedin'/)
  assert.match(linkedin, /mode:\s*'candidates'/)
  assert.match(linkedin, /scope:\s*target\.scope/)
})

test('Facebook group discovery exposes every group as its own durable target', () => {
  assert.match(jobs, /HIRING_FACEBOOK_GROUPS\.map/)
  assert.match(jobs, /platform:\s*'facebook' as const/)
  assert.match(jobs, /return allTargets\(\)\.map\(targetName\)/)
  assert.doesNotMatch(jobs, /FACEBOOK_CONCURRENCY/)
  assert.doesNotMatch(jobs, /targets\.slice\(/)
})

test('verified Facebook groups cover the supplied Uzbekistan and Romania markets', () => {
  const targets = new Map(HIRING_FACEBOOK_GROUPS.map((group) => [group.target, group]))
  assert.equal(targets.get('https://www.facebook.com/groups/worktashkent/')?.country, 'UZ')
  assert.equal(targets.get('https://www.facebook.com/groups/5239555629422157/')?.country, 'RO')
  assert.equal(targets.get('https://www.facebook.com/groups/1349245361776984/')?.country, 'KZ')
  assert.ok(HIRING_FACEBOOK_GROUPS.length >= 28)
})
