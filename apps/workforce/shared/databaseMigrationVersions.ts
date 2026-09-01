export const REQUIRED_DATABASE_MIGRATIONS = {
  jobs: '001_initial_read_model.sql',
  hiring: '001_candidate_read_model.sql',
  queue: '001_queue_schema.sql',
} as const

export type DatabaseMigrationComponent = keyof typeof REQUIRED_DATABASE_MIGRATIONS
