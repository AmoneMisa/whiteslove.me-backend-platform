import { hostname } from 'node:os'

import { jobsQueueStats } from '../shared/jobs/jobsPgQueue'
import { createWorkerHealthReporter } from './workerHealth'

export const WORKER_HEALTH_ID = String(
  process.env.JOBS_QUEUE_WORKER_ID || `${hostname()}:jobs`,
).slice(0, 200)

export const workerHealthReporter = createWorkerHealthReporter({
  workerId: WORKER_HEALTH_ID,
  getQueueStats: jobsQueueStats,
})
