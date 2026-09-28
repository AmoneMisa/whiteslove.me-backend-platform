import { useStateStore } from '../support/stateStore'

/**
 * hh.ru application token (https://api.hh.ru/openapi, "Application token").
 *
 * hh.ru closed anonymous API access, so vacancy search needs a Bearer token.
 * An application token comes from the client-credentials grant of the app
 * registered on dev.hh.ru. It does not expire, and hh.ru limits how often a
 * new one may be issued, so it is obtained once and kept in the state store
 * across restarts. HH_APP_TOKEN, when set, is used as is.
 */
const TOKEN_URL = 'https://api.hh.ru/token'
const STATE_KEY = 'jobs:hh-app-token:v1'
const STATE_TTL_SECONDS = 365 * 86_400
const USER_AGENT = 'WhitesLove-Hiring-Aggregator/1.0 (admin@whiteslove.me)'

let cached: string | null = null
let pending: Promise<string> | null = null

function env(name: string): string {
  return String(process.env[name] || '').trim()
}

export function hhCredentialsConfigured(): boolean {
  return Boolean(env('HH_APP_TOKEN') || (env('HH_CLIENT_ID') && env('HH_CLIENT_SECRET')))
}

async function requestToken(): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      'HH-User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env('HH_CLIENT_ID'),
      client_secret: env('HH_CLIENT_SECRET'),
    }),
  })
  // The response body can echo request details; report the status only.
  if (!response.ok) throw new Error(`api.hh.ru token -> ${response.status}`)
  const token = String(((await response.json()) as { access_token?: unknown })?.access_token || '').trim()
  if (!token) throw new Error('api.hh.ru token -> no access_token')
  return token
}

export async function hhAppToken(): Promise<string> {
  const configured = env('HH_APP_TOKEN')
  if (configured) return configured
  if (cached) return cached
  pending ??= (async () => {
    const store = useStateStore()
    const stored = String((await store.get(STATE_KEY)) || '').trim()
    const token = stored || await requestToken()
    if (!stored) await store.set(STATE_KEY, token, 'EX', STATE_TTL_SECONDS)
    cached = token
    return token
  })().finally(() => {
    pending = null
  })
  return pending
}

/** Forget a token hh.ru rejected, so the next call obtains a new one. */
export async function forgetHhAppToken(): Promise<void> {
  if (env('HH_APP_TOKEN')) return
  cached = null
  await useStateStore().set(STATE_KEY, '', 'EX', 1)
}
