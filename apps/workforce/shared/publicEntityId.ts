// Construct BigInts at runtime so the helper remains compatible with the
// project's ES2019 bundle target (which cannot parse BigInt literal syntax).
const PUBLIC_ID_MIN = BigInt('100000000000')
const PUBLIC_ID_RANGE = BigInt('900000000000')
const FNV_OFFSET = BigInt('14695981039346656037')
const FNV_PRIME = BigInt('1099511628211')

/** Stable public identity that works identically in Nitro and the browser. */
export function publicEntityId(kind: 'job' | 'candidate', ...identity: unknown[]): number {
  const key = [kind, ...identity].map((part) => String(part ?? '').trim()).join('\u001f')
  let hash = FNV_OFFSET
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * FNV_PRIME)
  }
  return Number(PUBLIC_ID_MIN + (hash % PUBLIC_ID_RANGE))
}
