// GET /jobs-employer?key=<employer key> — one employer collection and its live
// postings, newest first.
//
// A company below the two-role threshold answers the same as an unknown key:
// { employer: null }. A one-off posting is not a collection, and giving it a
// page would put a thin near-empty page behind every single advert.

import { getJobEmployerDb } from '../jobs/infrastructure/database'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const key = String(query.key ?? '').trim()
  if (!key) return { employer: null, jobs: [] }

  const requested = Number(query.limit ?? 100)
  const found = await getJobEmployerDb(key, Number.isFinite(requested) ? requested : 100)
  if (!found) return { employer: null, jobs: [] }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return found
})
