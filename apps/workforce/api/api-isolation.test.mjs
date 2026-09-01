import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8')

test('vacancies API imports only the vacancy route in its domain branch', () => {
  assert.match(source, /domain === 'vacancies'/)
  assert.match(source, /import\('\.\.\/server\/routes\/jobs-feed\.get\.ts'\)/)
})

test('CV API owns candidate feed and metadata routes', () => {
  assert.match(source, /hiring-feed\.get/)
  assert.match(source, /hiring-meta\.get/)
  assert.match(source, /WORKFORCE_API_DOMAIN must be vacancies or cv/)
})
