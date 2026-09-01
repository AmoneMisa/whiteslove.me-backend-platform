// Shared internal transport endpoint. Compose currently keeps the legacy service
// name during migration; callers talk to the transport directly, never via flats-api.
export function socialFetcherBaseUrl(): string {
  return String(process.env.SOCIAL_FETCHER_URL || 'http://flats-social-fetcher:4040').replace(/\/$/, '')
}
