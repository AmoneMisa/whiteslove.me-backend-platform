export const STANDARD_SOURCE_EXECUTION_POLICY = Object.freeze({
  concurrency: 10,
  requestTimeoutMs: 6_000,
})

export type SourceFetch = typeof fetch

/**
 * Apply the workforce-wide transport deadline without turning it into a crawl
 * completion condition. Existing caller cancellation remains authoritative.
 */
export function sourceRequestSignal(signal?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(STANDARD_SOURCE_EXECUTION_POLICY.requestTimeoutMs)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

export async function fetchWithSourceExecutionPolicy(
  input: Parameters<SourceFetch>[0],
  init: Parameters<SourceFetch>[1] = {},
  request: SourceFetch = fetch,
): Promise<Response> {
  return request(input, {
    ...init,
    signal: sourceRequestSignal(init?.signal),
  })
}
