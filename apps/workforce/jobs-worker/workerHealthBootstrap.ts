import { workerHealthReporter } from './workerHealthRuntime'

await workerHealthReporter.start()

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void workerHealthReporter.stop()
  })
}
