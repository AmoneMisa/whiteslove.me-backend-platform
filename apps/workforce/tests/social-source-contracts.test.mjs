import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { HIRING_FACEBOOK_GROUPS } from '../shared/hiring/sources/facebookGroups.ts'

const jobs = await readFile(new URL('../server/utils/socialJobSources.ts', import.meta.url), 'utf8')
const hiring = await readFile(new URL('../server/hiring/sources/socialRefresh.ts', import.meta.url), 'utf8')
const linkedin = await readFile(new URL('../server/hiring/sources/linkedInRefresh.ts', import.meta.url), 'utf8')
const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')

test('Threads vacancy discovery uses one durable target and passes the domain cutoff', () => {
  assert.match(jobs, /source:\s*'threads',\s*mode:\s*'search',\s*query:\s*target\.query,\s*cutoff/)
  assert.match(jobs, /const cutoff = crawlCutoff\(\)/)
  assert.match(jobs, /threadsJobCoverage\(\)/)
  assert.match(jobs, /configuredSocialJobTargets/)
  assert.match(jobs, /return fetchTarget\(config\)/)
  assert.doesNotMatch(jobs, /maxItemsPerSource/)
  assert.doesNotMatch(jobs, /\blimit\s*:/)
  assert.doesNotMatch(jobs, /Promise\.all(?:Settled)?/)
})

test('candidate social discovery uses the shared transport with its own domain cutoff', () => {
  assert.match(hiring, /source:\s*'threads',\s*mode:\s*'search',\s*query:\s*target\.query,\s*cutoff/)
  assert.match(hiring, /const cutoff = crawlCutoff\(\)/)
  assert.doesNotMatch(hiring, /maxItemsPerSource/)
  assert.doesNotMatch(hiring, /\blimit\s*:/)
  assert.match(compose, /HIRING_SOCIAL_API_URL:\s*http:\/\/flats-api:4000\/internal\/social\/fetch/u)
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
