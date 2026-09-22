// GET /jobs-employers?country=XX&limit=24 — companies with two or more
// different live roles, the jobs-board counterpart of Flat Finder's
// /flats-owners. Read-only over the persisted vacancy snapshot.
//
// "Different roles" counts distinct job clusters, so a single vacancy reposted
// weekly does not make a company look like it is hiring a team.
//
// Errors are data, not status codes: this API answers 200 with an empty list,
// the way jobs-vacancy answers { job: null }. Anything thrown here becomes a
// bare 500 (api/server.ts), which tells a caller nothing useful.

import { listJobEmployersDb } from '../jobs/infrastructure/database'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const country = String(query.country ?? '').trim().toUpperCase()
  // Empty means every country. A malformed code returns nothing rather than
  // being silently widened to everything.
  if (country && !/^[A-Z]{2}$/.test(country)) return { employers: [] }

  const requested = Number(query.limit ?? 24)
  const employers = await listJobEmployersDb(country, Number.isFinite(requested) ? requested : 24)
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return { employers }
})
