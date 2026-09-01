import { fetchWithSourceExecutionPolicy, type SourceFetch } from '../../../../packages/crawler-core/src/executionPolicy.ts'

const HIRING_WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export type HiringWebFetch = SourceFetch

export async function fetchHiringWebPage(
  url: string,
  request: HiringWebFetch = fetch,
): Promise<string> {
  const response = await fetchWithSourceExecutionPolicy(url, {
    headers: {
      'User-Agent': HIRING_WEB_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.8',
    },
  }, request)

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
