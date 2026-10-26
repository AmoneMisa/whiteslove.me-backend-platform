import { getJobActivityDb } from '../jobs/infrastructure/database'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const publicId = String(query.publicId || '')
  const section = String(query.section || 'history')
  const before = query.before == null ? undefined : String(query.before)
  if (!/^\d{1,15}$/.test(publicId) || Number(publicId) <= 0
    || !['history', 'duplicates'].includes(section)
    || (before != null && !/^\d{1,19}$/.test(before))) {
    throw Object.assign(new Error('Invalid activity query'), { statusCode: 400 })
  }
  const result = await getJobActivityDb(publicId, section, before)
  if (!result) throw Object.assign(new Error('Vacancy not found'), { statusCode: 404 })
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30')
  return result
})
