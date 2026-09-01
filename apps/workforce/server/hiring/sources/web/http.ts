const HIRING_WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const HIRING_WEB_REQUEST_TIMEOUT_MS = 25_000

export type HiringWebFetch = typeof fetch

export async function fetchHiringWebPage(
  url: string,
  request: HiringWebFetch = fetch,
): Promise<string> {
  const response = await request(url, {
    headers: {
      'User-Agent': HIRING_WEB_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
    signal: AbortSignal.timeout(HIRING_WEB_REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    let host = 'upstream'
    try {
      host = new URL(url).host
    } catch {
      // Keep malformed or non-URL source strings out of the error message.
    }
    throw new Error(`${host} -> ${response.status}`)
  }

  return response.text()
}
