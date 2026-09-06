import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8')

test('vacancies API imports only vacancy read routes in its domain branch', () => {
  assert.match(source, /domain === 'vacancies'/)
  assert.match(source, /import\('\.\.\/server\/routes\/jobs-feed\.get\.ts'\)/)
  assert.match(source, /import\('\.\.\/server\/routes\/jobs-vacancy\.get\.ts'\)/)
  assert.match(source, /\['\/jobs-feed', feed\.default\]/)
  assert.match(source, /\['\/jobs-vacancy', vacancy\.default\]/)
})

test('CV API owns candidate feed and metadata routes', () => {
  assert.match(source, /hiring-feed\.get/)
  assert.match(source, /hiring-meta\.get/)
  assert.match(source, /WORKFORCE_API_DOMAIN must be vacancies or cv/)
})

test('API separates liveness from database readiness', () => {
  assert.match(source, /url\.pathname === '\/health'/)
  assert.match(source, /url\.pathname === '\/ready'/)
  assert.match(source, /checkJobsDbReady\(\)/)
  assert.match(source, /checkHiringDbReady\(\)/)
  assert.match(source, /ok \? 200 : 503/)
})
