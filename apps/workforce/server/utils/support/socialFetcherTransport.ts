// Shared internal transport endpoint. Callers talk to the transport directly;
// no domain API proxies social transport for another backend domain.
export function socialFetcherBaseUrl(): string {
  return String(process.env.SOCIAL_FETCHER_URL || 'http://social-fetcher:4040').replace(/\/$/, '')
}
