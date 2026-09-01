import { existsSync, statSync } from 'node:fs'
import { dirname, extname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.json']

function existingFile(candidate) {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  if (!extname(candidate)) {
    for (const extension of EXTENSIONS) {
      const withExtension = `${candidate}${extension}`
      if (existsSync(withExtension) && statSync(withExtension).isFile()) return withExtension
    }
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    for (const extension of EXTENSIONS) {
      const indexFile = resolvePath(candidate, `index${extension}`)
      if (existsSync(indexFile) && statSync(indexFile).isFile()) return indexFile
    }
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let candidate = null

    if (specifier.startsWith('~~/')) {
      candidate = resolvePath(ROOT, specifier.slice(3))
    } else if (specifier.startsWith('@@/')) {
      candidate = resolvePath(ROOT, specifier.slice(3))
    } else if (
      (specifier.startsWith('./') || specifier.startsWith('../'))
      && context.parentURL?.startsWith('file:')
    ) {
      candidate = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)
    }

    if (candidate) {
      const found = existingFile(candidate)
      if (found) return { url: pathToFileURL(found).href, shortCircuit: true }
    }

    return nextResolve(specifier, context)
  },
})
