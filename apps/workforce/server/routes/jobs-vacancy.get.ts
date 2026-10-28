// GET /jobs-vacancy?id=<job id> or ?publicId=<public id> — read-only lookup in
// the persisted vacancy snapshot. Ingestion and enrichment happen in the
// vacancies worker before persistence.
//
// publicId is a one-way FNV hash of (source, id). Prefer the indexed database
// lookup when available, then preserve the snapshot fallback for compatibility.

import { getStoredJobsSnapshot } from '../vacancies/infrastructure/jobsSnapshot'
import { publicEntityId } from '../../shared/publicEntityId'
import { getJobByIdOrUrlDb, getJobByPublicIdDb, jobsReadFromDatabase } from '../jobs/infrastructure/database'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const id = String(query.id ?? '').trim()
  const publicId = String(query.publicId ?? '').trim()
  if (!id && !publicId) return { job: null }

  if (publicId) {
    const databaseJob = await getJobByPublicIdDb(publicId)
    if (databaseJob) {
      return { job: { ...databaseJob, publicId: publicEntityId('job', databaseJob.source, databaseJob.id) } }
    }
  }

  if (jobsReadFromDatabase()) {
    // The table is the store: no second look in a file that holds the same vacancies.
    const databaseJob = id ? await getJobByIdOrUrlDb(id) : null
    return {
      job: databaseJob ? { ...databaseJob, publicId: publicEntityId('job', databaseJob.source, databaseJob.id) } : null,
    }
  }

  const jobs = await getStoredJobsSnapshot()
  const found = id
    ? jobs.find((job) => job.id === id || job.url === id)
    : jobs.find((job) => String(publicEntityId('job', job.source, job.id)) === publicId)
  return {
    job: found
      ? { ...found, publicId: publicEntityId('job', found.source, found.id) }
      : null,
  }
})
