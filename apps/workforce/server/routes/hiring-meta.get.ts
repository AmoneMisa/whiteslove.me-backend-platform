// GET /hiring-meta — country/city metadata for the hiring page filters.

import { HIRING_COUNTRIES } from '../../shared/hiring/hiringMarkets'

// The country selector represents markets the hiring board actually crawls.
// A candidate from a supported source may currently live elsewhere, but that
// must not silently turn an arbitrary country into a selectable market.
const EXTRA_COUNTRIES = [
  { code: 'RO', name: 'Romania', currency: 'RON', cities: ['Bucharest', 'Cluj-Napoca', 'Iasi', 'Timisoara', 'Brasov'] },
] as const

export default defineEventHandler((event) => {
  setResponseHeader(event, 'Cache-Control', 'private, max-age=3600')
  return [...HIRING_COUNTRIES, ...EXTRA_COUNTRIES]
})
