import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// A raw NUL (or other control byte) in a source file makes git treat the whole
// file as binary, so its diffs never show in `git diff`, reviews or `git log -p`.
// Use an escape ('\u0000') instead; the runtime string is identical.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIRS = ['src', 'test', 'scripts', 'migrations']
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

async function* sources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(?:[cm]?[jt]s|sql)$/u.test(entry.name)) yield path
  }
}

test('source files contain no raw control bytes', async () => {
  const offenders = []
  for (const dir of DIRS) {
    for await (const path of sources(join(ROOT, dir))) {
      if (CONTROL.test(await readFile(path, 'utf8'))) offenders.push(path)
    }
  }
  assert.deepEqual(offenders, [])
})
