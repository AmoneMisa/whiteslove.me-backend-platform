export const STANDARD_SOURCE_EXECUTION_POLICY = Object.freeze({
  concurrency: 10,
  requestTimeoutMs: 6_000,
  maxItemsPerSource: 60,
})

export type SourceFetch = typeof fetch

/**
 * Apply the workforce-wide request deadline without letting source adapters
 * own timeout values. Existing caller cancellation remains authoritative too.
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
