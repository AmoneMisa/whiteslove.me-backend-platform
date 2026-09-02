import {pool} from './pool.js';
import {listMigrationFiles} from '../../support/migration-files.js';

export async function assertDatabaseReady() {
  const relationResult = await pool.query(`
    SELECT
      to_regclass('schema_migrations')::text AS schema_migrations,
      to_regclass('listings')::text AS listings,
      to_regclass('crawl_tasks')::text AS crawl_tasks,
      to_regclass('crawl_task_runs')::text AS crawl_task_runs,
      to_regclass('places')::text AS places
  `);

  const relations = relationResult.rows[0] || {};
  const missingRelations = Object.entries(relations)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingRelations.length) {
    throw new Error(
      `database schema is not migrated; missing ${missingRelations.join(', ')}. ` +
      'Run `npm run migrate --prefix backend` before starting the API or worker.',
    );
  }

  const required = await listMigrationFiles();
  const appliedResult = await pool.query(
    'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
    [required],
  );
  const applied = new Set(appliedResult.rows.map((row) => row.version));
  const missingMigrations = required.filter((version) => !applied.has(version));

  if (missingMigrations.length) {
    throw new Error(
      `database migrations are incomplete; missing ${missingMigrations.join(', ')}. ` +
      'Run `npm run migrate --prefix backend` before starting the API or worker.',
    );
  }
}
