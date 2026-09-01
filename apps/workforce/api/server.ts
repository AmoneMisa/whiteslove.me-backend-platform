import { createServer } from 'node:http'

import './h3-compat'
import type { ApiEvent, Handler } from './h3-compat'

const domain = String(process.env.WORKFORCE_API_DOMAIN || '').trim().toLowerCase()
if (!['vacancies', 'cv'].includes(domain)) {
  throw new Error('WORKFORCE_API_DOMAIN must be vacancies or cv')
}

const port = Number(process.env.PORT) || (domain === 'vacancies' ? 4010 : 4011)

async function routes(): Promise<Map<string, Handler>> {
  if (domain === 'vacancies') {
    const feed = await import('../server/routes/jobs-feed.get.ts')
    return new Map([['/jobs-feed', feed.default]])
  }

  const [feed, meta] = await Promise.all([
    import('../server/routes/hiring-feed.get.ts'),
    import('../server/routes/hiring-meta.get.ts'),
  ])
  return new Map([
    ['/hiring-feed', feed.default],
    ['/hiring-meta', meta.default],
  ])
}

const handlers = await routes()

const server = createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host || `localhost:${port}`}${req.url || '/'}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
  })
  const url = new URL(request.url)

  if (url.pathname === '/health' || url.pathname === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, domain }))
    return
  }

  if (req.method !== 'GET' || !handlers.has(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
    return
  }

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' })
  const event: ApiEvent = { request, headers }
  try {
    const body = await handlers.get(url.pathname)!(event)
    res.writeHead(200, Object.fromEntries(headers.entries()))
    res.end(JSON.stringify(body))
  } catch (error) {
    console.error(`[${domain}:api] request failed:`, error instanceof Error ? error.stack || error.message : error)
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'internal_error' }))
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[${domain}:api] listening on ${port}`)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
