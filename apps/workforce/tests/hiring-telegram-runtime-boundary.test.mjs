import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const runtime = readFileSync(new URL('../server/hiring/sources/telegramRuntime.ts', import.meta.url), 'utf8')
const diagnostics = readFileSync(new URL('../server/hiring/sources/telegramDiagnostics.ts', import.meta.url), 'utf8')
const refresh = readFileSync(new URL('../server/hiring/application/refreshTelegramChannel.ts', import.meta.url), 'utf8')

test('Telegram hiring runtime lives in the hiring source layer', () => {
  assert.match(runtime, /async function fetchWorkerPage/u)
  assert.match(runtime, /recordHiringSourceDiagnostic/u)
  assert.match(diagnostics, /let telegramDiagnostics/u)
  assert.match(refresh, /from '\.\.\/sources\/telegramRuntime'/u)
  assert.doesNotMatch(refresh, /utils\/hiringSources/u)
})
