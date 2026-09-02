import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8')
const packageLock = await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')
const workerDockerfile = await readFile(new URL('../jobs-worker/Dockerfile', import.meta.url), 'utf8')

test('Docker dependency installation does not require git or SSH', () => {
  const gitDependencyReference = /git\+ssh:|git@github\.com|github:AmoneMisa\//
  assert.doesNotMatch(packageJson, gitDependencyReference)
  assert.doesNotMatch(packageLock, gitDependencyReference)
  assert.match(packageLock, /"resolved":\s*"https:\/\/registry\.npmjs\.org\/@whiteslove\/parsing-lexicon\//)
  assert.match(workerDockerfile, /RUN npm ci --omit=dev --no-audit --no-fund/)
})
