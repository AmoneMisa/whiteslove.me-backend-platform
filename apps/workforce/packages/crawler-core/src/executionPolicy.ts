export const STANDARD_SOURCE_EXECUTION_POLICY = Object.freeze({
  concurrency: 10,
  requestTimeoutMs: 6_000,
})

// Authenticated or sidecar-backed sources need a longer transport deadline,
// but the policy still belongs to the shared crawler layer rather than an
// individual source adapter.
export const LINKEDIN_VOYAGER_EXECUTION_POLICY = Object.freeze({
  concurrency: 4,
  requestTimeoutMs: 12_000,
})

export const LINKEDIN_SIDECAR_EXECUTION_POLICY = Object.freeze({
  concurrency: 1,
  requestTimeoutMs: 180_000,
})

export type SourceExecutionPolicy = Readonly<{
  concurrency: number
  requestTimeoutMs: number
}>

export type SourceFetch = typeof fetch

/**
 * Apply the workforce-wide transport deadline without turning it into a crawl
 * completion condition. Existing caller cancellation remains authoritative.
 */
export function sourceRequestSignal(
  signal?: AbortSignal | null,
  policy: SourceExecutionPolicy = STANDARD_SOURCE_EXECUTION_POLICY,
): AbortSignal {
  const deadline = AbortSignal.timeout(policy.requestTimeoutMs)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

export async function fetchWithSourceExecutionPolicy(
  input: Parameters<SourceFetch>[0],
  init: Parameters<SourceFetch>[1] = {},
  request: SourceFetch = fetch,
  policy: SourceExecutionPolicy = STANDARD_SOURCE_EXECUTION_POLICY,
): Promise<Response> {
  return request(input, {
    ...init,
    signal: sourceRequestSignal(init?.signal, policy),
  })
}

/** Run source work with the shared concurrency budget while preserving order. */
export async function mapWithSourceConcurrency<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency = STANDARD_SOURCE_EXECUTION_POLICY.concurrency,
): Promise<R[]> {
  const output = new Array<R>(items.length)
  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      output[index] = await mapper(items[index]!, index)
    }
  }
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(concurrency))) }, () => worker())
  await Promise.all(workers)
  return output
}
