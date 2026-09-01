import { evaluateWorkerHealth, readWorkerHealthSnapshot } from './workerHealth'

const snapshot = await readWorkerHealthSnapshot()
const result = evaluateWorkerHealth(snapshot)

if (!result.ok) {
  console.error(`[jobs:worker] unhealthy: ${result.reason || 'unknown'}`)
  process.exit(1)
}
